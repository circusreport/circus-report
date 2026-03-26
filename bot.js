const TelegramBot = require('node-telegram-bot-api');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const express = require('express');
const ogs = require('open-graph-scraper');
const cheerio = require('cheerio');

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

async function fetchImages(url) {
  const images = [];
  try {
    const { result } = await ogs({ url });
    if (result.ogImage) {
      const ogImages = Array.isArray(result.ogImage) ? result.ogImage : [result.ogImage];
      ogImages.forEach(img => {
        const imgUrl = typeof img === 'string' ? img : img.url;
        if (imgUrl && !images.includes(imgUrl)) images.push(imgUrl);
      });
    }
    if (result.twitterImage) {
      const twitterImages = Array.isArray(result.twitterImage) ? result.twitterImage : [result.twitterImage];
      twitterImages.forEach(img => {
        const imgUrl = typeof img === 'string' ? img : img.url;
        if (imgUrl && !images.includes(imgUrl)) images.push(imgUrl);
      });
    }
  } catch (err) {
    console.log('OGS fetch error:', err.message);
  }
  return images.slice(0, 3);
}

async function presentImages(chatId, userId, images, pending) {
  if (images.length === 0) {
    await savePending(userId, { ...pending, step: 'awaiting_custom_image' });
    bot.sendMessage(chatId, 'No preview images found for this URL.\n\nSend me an image to upload, or reply "skip" to use no image.');
    return;
  }

  await savePending(userId, { ...pending, availableImages: images, step: 'awaiting_image_choice' });

  for (let i = 0; i < images.length; i++) {
    try {
      await bot.sendPhoto(chatId, images[i], { caption: 'Option ' + (i + 1) });
    } catch (err) {
      console.log('Could not send image ' + (i + 1) + ':', err.message);
    }
  }

  let message = 'Reply with a number to choose an image:\n';
  for (let i = 0; i < images.length; i++) {
    message += (i + 1) + ' - Use this image\n';
  }
  message += '\nOr reply:\n"upload" - Upload your own image\n"skip" - No image';
  bot.sendMessage(chatId, message);
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

  // Cancel command
  if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
    await clearPending(userId);
    bot.sendMessage(chatId, 'Cancelled. Send a URL to get started.');
    return;
  }

// Delete command
  if (text.toLowerCase() === 'delete' || text.toLowerCase() === '/delete') {
    const data = await getLinks();
    if (!data.links || data.links.length === 0) {
      bot.sendMessage(chatId, 'No links to delete.');
      return;
    }
    await savePending(userId, { step: 'awaiting_delete_choice' });
    let message = 'Which link do you want to delete?\n\n';
    data.links.forEach((link, i) => {
      message += (i + 1) + '. ' + link.headline + '\n';
    });
    message += '\nReply with a number, or "cancel" to go back.';
    bot.sendMessage(chatId, message);
    return;
  }

  // Awaiting delete choice
  if (pending && pending.step === 'awaiting_delete_choice') {
    const num = parseInt(text.trim());
    const data = await getLinks();
    if (isNaN(num) || num < 1 || num > data.links.length) {
      bot.sendMessage(chatId, 'Invalid number. Reply with a number from the list, or "cancel".');
      return;
    }
    const removed = data.links.splice(num - 1, 1)[0];
    data.lastUpdated = new Date().toISOString();
    await saveLinks(data);
    await clearPending(userId);
    bot.sendMessage(chatId, 'Deleted: ' + removed.headline);
    return;
  }
  
  // New URL submission
  if (text.startsWith('http')) {
    await savePending(userId, { url: text, step: 'fetching_images' });
    bot.sendMessage(chatId, 'Got the URL. Fetching preview images...');
    const images = await fetchImages(text);
    const pending = await getPending(userId);
    await presentImages(chatId, userId, images, pending);
    return;
  }

  const pending = await getPending(userId);
  console.log('Retrieved pending state:', JSON.stringify(pending));

  if (!pending) {
    bot.sendMessage(chatId, 'Send me a URL to get started.');
    return;
  }

  // Awaiting delete choice
  if (pending.step === 'awaiting_delete_choice') {
    const num = parseInt(text.trim());
    const data = await getLinks();
    if (isNaN(num) || num < 1 || num > data.links.length) {
      bot.sendMessage(chatId, 'Invalid number. Reply with a number from the list, or "cancel".');
      return;
    }
    const removed = data.links.splice(num - 1, 1)[0];
    data.lastUpdated = new Date().toISOString();
    await saveLinks(data);
    await clearPending(userId);
    bot.sendMessage(chatId, 'Deleted: ' + removed.headline);
    return;
  }

  // Awaiting image choice
  if (pending.step === 'awaiting_image_choice') {
    const choice = text.trim();

    if (choice === 'skip') {
      await savePending(userId, { ...pending, image: null, step: 'awaiting_headline' });
      bot.sendMessage(chatId, 'No image. Now send me the headline.');
      return;
    }

    if (choice === 'upload') {
      await savePending(userId, { ...pending, step: 'awaiting_custom_image' });
      bot.sendMessage(chatId, 'Send me the image you want to upload.');
      return;
    }

    const num = parseInt(choice);
    if (!isNaN(num) && num >= 1 && num <= pending.availableImages.length) {
      const chosenImage = pending.availableImages[num - 1];
      await savePending(userId, { ...pending, image: chosenImage, step: 'awaiting_headline' });
      bot.sendMessage(chatId, 'Image selected. Now send me the headline.');
      return;
    }

    bot.sendMessage(chatId, 'Please reply with a number, "upload", or "skip".');
    return;
  }

  // Awaiting custom image upload
  if (pending.step === 'awaiting_custom_image') {
    if (text.toLowerCase() === 'skip') {
      await savePending(userId, { ...pending, image: null, step: 'awaiting_headline' });
      bot.sendMessage(chatId, 'No image. Now send me the headline.');
      return;
    }

    if (photo) {
      const fileId = photo[photo.length - 1].file_id;
      bot.sendMessage(chatId, 'Uploading your image to Cloudinary...');
      try {
        const file = await bot.getFile(fileId);
        const fileUrl = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_TOKEN + '/' + file.file_path;
        const uploadResult = await cloudinary.uploader.upload(fileUrl);
        console.log('Cloudinary upload result:', uploadResult.secure_url);
        await savePending(userId, { ...pending, image: uploadResult.secure_url, step: 'awaiting_headline' });
        bot.sendMessage(chatId, 'Image uploaded. Now send me the headline.');
      } catch (err) {
        console.error('Cloudinary upload error:', err);
        bot.sendMessage(chatId, 'Image upload failed. Try again or reply "skip".');
      }
      return;
    }

    bot.sendMessage(chatId, 'Please send an image or reply "skip".');
    return;
  }

  // Awaiting headline
  if (pending.step === 'awaiting_headline') {
    await savePending(userId, { ...pending, headline: text, step: 'awaiting_position' });
    bot.sendMessage(chatId, 'Make this the top story? Reply yes or no.');
    return;
  }

  // Awaiting position
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

  bot.sendMessage(chatId, 'Send me a URL to get started.');
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
