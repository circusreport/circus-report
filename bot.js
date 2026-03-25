const TelegramBot = require('node-telegram-bot-api');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
console.log('Bot initialized, polling for messages...');
const AUTHORIZED_USER = parseInt(process.env.TELEGRAM_USER_ID);

// Store pending submissions temporarily
const pending = {};

// Helper: get current links.json from GitHub
async function getLinksJson() {
  const url = `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}/contents/links.json`;
  const response = await axios.get(url, {
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
  });
  const content = Buffer.from(response.data.content, 'base64').toString('utf8');
  return { data: JSON.parse(content), sha: response.data.sha };
}

// Helper: save updated links.json to GitHub
async function saveLinksJson(data, sha) {
  const url = `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}/contents/links.json`;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  await axios.put(url, {
    message: 'Update links via bot',
    content,
    sha
  }, {
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
  });
}

// Step 1: User sends a URL
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Block anyone who isn't you
  if (userId !== AUTHORIZED_USER) {
    bot.sendMessage(chatId, 'Unauthorized.');
    return;
  }

  const text = msg.text || '';
  const photo = msg.photo;

  // If user sends a URL
  if (text.startsWith('http')) {
    pending[userId] = { url: text, step: 'awaiting_headline' };
    bot.sendMessage(chatId, 'Got the URL. Now send me the headline.');
    return;
  }

  // If user sends a photo
  if (photo) {
    const fileId = photo[photo.length - 1].file_id;
    bot.sendMessage(chatId, 'Got the image. Uploading to Cloudinary...');
    try {
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;
      const uploadResult = await cloudinary.uploader.upload(fileUrl);
      pending[userId] = { ...pending[userId], image: uploadResult.secure_url };
      bot.sendMessage(chatId, 'Image uploaded. Now send me the URL for this story.');
      pending[userId].step = 'awaiting_url_after_image';
    } catch (err) {
      bot.sendMessage(chatId, 'Image upload failed. Try again.');
    }
    return;
  }

  // If awaiting headline
  if (pending[userId]?.step === 'awaiting_headline') {
    pending[userId].headline = text;
    pending[userId].step = 'awaiting_position';
    bot.sendMessage(chatId, 'Make this the top story? Reply yes or no.');
    return;
  }

  // If awaiting URL after image
  if (pending[userId]?.step === 'awaiting_url_after_image') {
    pending[userId].url = text;
    pending[userId].step = 'awaiting_headline';
    bot.sendMessage(chatId, 'Got it. Now send me the headline.');
    return;
  }

  // If awaiting position
  if (pending[userId]?.step === 'awaiting_position') {
    const makeTop = text.toLowerCase() === 'yes';
    try {
      const { data, sha } = await getLinksJson();
      const newLink = {
        headline: pending[userId].headline,
        url: pending[userId].url,
        ...(pending[userId].image && { image: pending[userId].image })
      };

      if (makeTop) {
        data.links.unshift(newLink);
      } else {
        data.links.push(newLink);
      }

      data.lastUpdated = new Date().toISOString();
      await saveLinksJson(data, sha);
      delete pending[userId];
      bot.sendMessage(chatId, makeTop ? 'Done! Posted as top story.' : 'Done! Added to the list.');
    } catch (err) {
      bot.sendMessage(chatId, 'Something went wrong updating the site. Try again.');
      console.error(err);
    }
    return;
  }

  bot.sendMessage(chatId, 'Send me a URL or an image to get started.');
});

// Keep Railway happy with a health check endpoint
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
