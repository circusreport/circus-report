const TelegramBot = require('node-telegram-bot-api');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { webHook: true });
const AUTHORIZED_USER = parseInt(process.env.TELEGRAM_USER_ID);

const WORKER_BASE = process.env.CLOUDFLARE_WORKER_URL.replace('/links', '');
const AUTH_HEADER = { Authorization: 'Bearer ' + process.env.BOT_SECRET };

async function getLinks() {
  const response = await axios.get(WORKER_BASE + '/links', { headers: AUTH_HEADER });
  return response.data;
}

async function saveLinks(data) {
  await axios.post(WORKER_BASE + '/links', data, {
    headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' }
  });
}

async function getPending(userId) {
  const response = await axios.get(WORKER_BASE + '/pending/' + userId, { headers: AUTH_HEADER });
  return response.data;
}

async function savePending(userId, data) {
  await axios.post(WORKER_BASE + '/pending/' + userId, data, {
    headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' }
  });
}

async function clearPending(userId) {
  await axios.delete(WORKER_BASE + '/pending/' + userId, { headers: AUTH_HEADER });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== AUTHORIZED_USER) {
    bot.sendMessage(chatId, 'Unauthorized.');
    return;
  }

  const text = msg.text || '';
  const photo = msg.photo;

  if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
    await clearPending(userId);
    bot.sendMessage(chatId, 'Cancelled. Send a URL or image to start over.');
    return;
  }

  if (text.startsWith('http')) {
    await savePending(userId, { url: text, step: 'awaiting_headline' });
    bot.sendMessage(chatId, 'Got the URL. Now send me the headline.');
    return;
  }

  if (photo) {
    console.log('Photo received from user:', userId);
    const fileId = photo[photo.length - 1].file_id;
    bot.sendMessage(chatId, 'Got the image. Uploading to Cloudinary...');
    try {
      const file = await bot.getFile(fileId);
      const fileUrl = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_TOKEN + '/' + file.file_path;
      console.log('Attempting Cloudinary upload from URL:', fileUrl);
      const uploadResult = await cloudinary.uploader.upload(fileUrl);
      console.log('Cloudinary upload result:', uploadResult.secure_url);
      await savePending(userId, {
        image: uploadResult.secure_url,
        step: 'awaiting_url_after_image'
      });
      console.log('Pending state saved to KV');
      bot.sendMessage(chatId, 'Image uploaded. Now send me the URL for this story.');
    } catch (err) {
      console.error('Cloudinary upload error:', err);
      bot.sendMessage(chatId, 'Image upload failed. Try again.');
    }
    return;
  }

  const pending = await getPending(userId);
  console.log('Retrieved pending state:', JSON.stringify(pending));

  if (!pending) {
    bot.sendMessage(chatId, 'Send me a URL or an image to get started.');
    return;
  }

  if (pending.step === 'awaiting_headline') {
    await savePending(userId, { ...pending, headline: text, step: 'awaiting_position' });
    bot.sendMessage(chatId, 'Make this the top story? Reply yes or no.');
    return;
  }

  if (pending.step === 'awaiting_url_after_image') {
    await savePending(userId, { ...pending, url: text, step: 'awaiting_headline' });
    bot.sendMessage(chatId, 'Got it. Now send me the headline.');
    return;
  }

  if (pending.step === 'awaiting_position') {
    const makeTop = text.toLowerCase() === 'yes';
    try {
      const data = await getLinks();
      const newLink = {
        headline: pending.headline,
        url: pending.url
      };
      if (pending.image) {
        newLink.image = pending.image;
      }
      if (makeTop) {
        data.links.unshift(newLink);
      } else {
        data.links.push(newLink);
      }
      data.lastUpdated = new Date().toISOString();
      await saveLinks(data);
      await clearPending(userId);
      console.log('Links saved successfully to Cloudflare KV');
      bot.sendMessage(chatId, makeTop ? 'Done! Posted as top story.' : 'Done! Added to the list.');
    } catch (err) {
      bot.sendMessage(chatId, 'Something went wrong updating the site. Try again.');
      console.error('Error saving links:', err);
    }
    return;
  }

  bot.sendMessage(chatId, 'Send me a URL or an image to get started.');
}

bot.on('message', handleMessage);

app.post('/webhook/' + process.env.TELEGRAM_TOKEN, function(req, res) {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', function(req, res) {
  res.send('Bot is running.');
});

app.listen(PORT, async function() {
  console.log('Server running on port ' + PORT);
  const webhookUrl = process.env.RAILWAY_STATIC_URL + '/webhook/' + process.env.TELEGRAM_TOKEN;
  console.log('Setting webhook to:', webhookUrl);
  try {
    await bot.setWebHook(webhookUrl);
    console.log('Webhook set successfully.');
  } catch (err) {
    console.error('Failed to set webhook:', err);
  }
});
