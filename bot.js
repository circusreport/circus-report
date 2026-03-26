const TelegramBot = require('node-telegram-bot-api');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const express = require('express');
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
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      timeout: 10000
    });
    const $ = cheerio.load(response.data);
    const og = $('meta[property="og:image"]').attr('content');
    const twitter = $('meta[name="twitter:image"]').attr('content');
    if (og && !images.includes(og)) images.push(og);
    if (twitter && !images.includes(twitter)) images.push(twitter);
  } catch (err) {
    console.log('Image fetch error:', err.message);
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

  // Edit command
  if (text.toLowerCase() === 'edit' || text.toLowerCase() === '/edit') {
    const data = await getLinks();
    if (!data.links || data.links.length === 0) {
      bot.sendMessage(chatId, 'No links to edit.');
      return;
    }
    await savePending(userId, { step: 'awaiting_edit_choice' });
    let message = 'Which headline do you want to edit?\n\n';
    data.links.forEach((link, i) => {
      message += (i + 1) + '. ' + link.headline + '\n';
    });
    message += '\nReply with a number, or "cancel" to go back.';
    bot.sendMessage(chatId, message);
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

  // Awaiting edit choice
  if (pending.step === 'awaiting_edit_choice') {
    const num = parseInt(text.trim());
    const data = await getLinks();
    if (isNaN(num) || num < 1 || num > data.links.length) {
      bot.sendMessage(chatId, 'Invalid number. Reply with a number from the list, or "cancel".');
      return;
    }
    const targetLink = data.links[num - 1];
    await savePending(userId, { step: 'awaiting_new_headline', editIndex: num - 1, oldHeadline: targetLink.headline });
    bot.sendMessage(chatId, 'Current headline:\n"' + targetLink.headline + '"\n\nSend me the new headline.');
    return;
  }

  // Awaiting new headline for edit
  if (pending.step === 'awaiting_new_headline') {
    await savePending(userId, { ...pending, newHeadline: text, step: 'awaiting_edit_confirm' });
    bot.sendMessage(chatId, 'Are you sure you want to change:\n\nFrom: "' + pending.oldHeadline + '"\nTo: "' + text + '"\n\nReply "yes" to confirm or "cancel" to go back.');
    return;
  }

  // Awaiting edit confirmation
  if (pending.step === 'awaiting_edit_confirm') {
    if (text.toLowerCase() === 'yes') {
      const data = await getLinks();
      const currentImage = data.links[pending.editIndex].image;
      const current = currentImage ? 'Yes (image set)' : 'None';
      await savePending(userId, { ...pending, step: 'awaiting_edit_image_choice' });
      bot.sendMessage(chatId, 'Headline updated. Now what do you want to do with the image? (current: ' + current + ')\n\n' +
        '"keep" - Keep current image\n' +
        '"fetch" - Fetch new images from the URL\n' +
        '"upload" - Upload your own image\n' +
        '"remove" - Remove image entirely');
    } else {
      await clearPending(userId);
      bot.sendMessage(chatId, 'Cancelled. Headline was not changed.');
    }
    return;
  }

  // Awaiting edit image choice
  if (pending.step === 'awaiting_edit_image_choice') {
    const choice = text.toLowerCase().trim();

    if (choice === 'keep') {
      await savePending(userId, { ...pending, step: 'awaiting_edit_category' });
      const data = await getLinks();
      const currentCategory = data.links[pending.editIndex].category;
      const currentEmoji = data.links[pending.editIndex].emoji;
      const current = currentCategory ? currentEmoji + ' ' + currentCategory : 'None';
      const categoryMessage = 'Image kept. Now choose a category (current: ' + current + '):\n\n' +
        '1. 🏦 US Politics\n' +
        '2. 📺 News Media\n' +
        '3. 🎭 Society & Culture\n' +
        '4. 🏆 Sports News\n' +
        '5. 💻 Tech News\n' +
        '6. 🎬 Entertainment\n' +
        '7. 🌍 World News\n' +
        '8. 📈 Economy & Business\n' +
        '9. ⚖️ Crime & Law\n' +
        '10. 🧬 Health & Science\n\n' +
        'Reply with a number, or "keep" to leave it unchanged.';
      bot.sendMessage(chatId, categoryMessage);
      return;
    }

    if (choice === 'remove') {
      await savePending(userId, { ...pending, newImage: null, step: 'awaiting_edit_category' });
      const data = await getLinks();
      const currentCategory = data.links[pending.editIndex].category;
      const currentEmoji = data.links[pending.editIndex].emoji;
      const current = currentCategory ? currentEmoji + ' ' + currentCategory : 'None';
      const categoryMessage = 'Image removed. Now choose a category (current: ' + current + '):\n\n' +
        '1. 🏦 US Politics\n' +
        '2. 📺 News Media\n' +
        '3. 🎭 Society & Culture\n' +
        '4. 🏆 Sports News\n' +
        '5. 💻 Tech News\n' +
        '6. 🎬 Entertainment\n' +
        '7. 🌍 World News\n' +
        '8. 📈 Economy & Business\n' +
        '9. ⚖️ Crime & Law\n' +
        '10. 🧬 Health & Science\n\n' +
        'Reply with a number, or "keep" to leave it unchanged.';
      bot.sendMessage(chatId, categoryMessage);
      return;
    }

    if (choice === 'fetch') {
      bot.sendMessage(chatId, 'Fetching images from URL...');
      const data = await getLinks();
      const url = data.links[pending.editIndex].url;
      const images = await fetchImages(url);
      if (images.length === 0) {
        await savePending(userId, { ...pending, step: 'awaiting_edit_custom_image' });
        bot.sendMessage(chatId, 'No preview images found.\n\nSend me an image to upload, or reply "skip" to keep current image.');
        return;
      }
      await savePending(userId, { ...pending, availableImages: images, step: 'awaiting_edit_image_select' });
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
      message += '\nOr reply "skip" to keep current image.';
      bot.sendMessage(chatId, message);
      return;
    }

    if (choice === 'upload') {
      await savePending(userId, { ...pending, step: 'awaiting_edit_custom_image' });
      bot.sendMessage(chatId, 'Send me the image you want to upload.');
      return;
    }

    bot.sendMessage(chatId, 'Please reply with "keep", "fetch", "upload", or "remove".');
    return;
  }

  // Awaiting edit image select from fetched options
  if (pending.step === 'awaiting_edit_image_select') {
    const choice = text.trim();
    if (choice === 'skip') {
      await savePending(userId, { ...pending, step: 'awaiting_edit_category' });
    } else {
      const num = parseInt(choice);
      if (isNaN(num) || num < 1 || num > pending.availableImages.length) {
        bot.sendMessage(chatId, 'Please reply with a number or "skip".');
        return;
      }
      await savePending(userId, { ...pending, newImage: pending.availableImages[num - 1], step: 'awaiting_edit_category' });
    }
    const data = await getLinks();
    const currentCategory = data.links[pending.editIndex].category;
    const currentEmoji = data.links[pending.editIndex].emoji;
    const current = currentCategory ? currentEmoji + ' ' + currentCategory : 'None';
    const categoryMessage = 'Image updated. Now choose a category (current: ' + current + '):\n\n' +
      '1. 🏦 US Politics\n' +
      '2. 📺 News Media\n' +
      '3. 🎭 Society & Culture\n' +
      '4. 🏆 Sports News\n' +
      '5. 💻 Tech News\n' +
      '6. 🎬 Entertainment\n' +
      '7. 🌍 World News\n' +
      '8. 📈 Economy & Business\n' +
      '9. ⚖️ Crime & Law\n' +
      '10. 🧬 Health & Science\n\n' +
      'Reply with a number, or "keep" to leave it unchanged.';
    bot.sendMessage(chatId, categoryMessage);
    return;
  }

  // Awaiting edit custom image upload
  if (pending.step === 'awaiting_edit_custom_image') {
    if (text.toLowerCase() === 'skip') {
      await savePending(userId, { ...pending, step: 'awaiting_edit_category' });
      const data = await getLinks();
      const currentCategory = data.links[pending.editIndex].category;
      const currentEmoji = data.links[pending.editIndex].emoji;
      const current = currentCategory ? currentEmoji + ' ' + currentCategory : 'None';
      const categoryMessage = 'Image kept. Now choose a category (current: ' + current + '):\n\n' +
        '1. 🏦 US Politics\n' +
        '2. 📺 News Media\n' +
        '3. 🎭 Society & Culture\n' +
        '4. 🏆 Sports News\n' +
        '5. 💻 Tech News\n' +
        '6. 🎬 Entertainment\n' +
        '7. 🌍 World News\n' +
        '8. 📈 Economy & Business\n' +
        '9. ⚖️ Crime & Law\n' +
        '10. 🧬 Health & Science\n\n' +
        'Reply with a number, or "keep" to leave it unchanged.';
      bot.sendMessage(chatId, categoryMessage);
      return;
    }
    if (photo) {
      const fileId = photo[photo.length - 1].file_id;
      bot.sendMessage(chatId, 'Uploading your image to Cloudinary...');
      try {
        const file = await bot.getFile(fileId);
        const fileUrl = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_TOKEN + '/' + file.file_path;
        const uploadResult = await cloudinary.uploader.upload(fileUrl);
        await savePending(userId, { ...pending, newImage: uploadResult.secure_url, step: 'awaiting_edit_category' });
        const data = await getLinks();
        const currentCategory = data.links[pending.editIndex].category;
        const currentEmoji = data.links[pending.editIndex].emoji;
        const current = currentCategory ? currentEmoji + ' ' + currentCategory : 'None';
        const categoryMessage = 'Image uploaded. Now choose a category (current: ' + current + '):\n\n' +
          '1. 🏦 US Politics\n' +
          '2. 📺 News Media\n' +
          '3. 🎭 Society & Culture\n' +
          '4. 🏆 Sports News\n' +
          '5. 💻 Tech News\n' +
          '6. 🎬 Entertainment\n' +
          '7. 🌍 World News\n' +
          '8. 📈 Economy & Business\n' +
          '9. ⚖️ Crime & Law\n' +
          '10. 🧬 Health & Science\n\n' +
          'Reply with a number, or "keep" to leave it unchanged.';
        bot.sendMessage(chatId, categoryMessage);
      } catch (err) {
        console.error('Cloudinary upload error:', err);
        bot.sendMessage(chatId, 'Image upload failed. Try again or reply "skip".');
      }
      return;
    }
    bot.sendMessage(chatId, 'Please send an image or reply "skip".');
    return;
  }

  // Awaiting edit category
  if (pending.step === 'awaiting_edit_category') {
    const categories = [
      { label: 'US Politics', emoji: '🏦' },
      { label: 'News Media', emoji: '📺' },
      { label: 'Society & Culture', emoji: '🎭' },
      { label: 'Sports News', emoji: '🏆' },
      { label: 'Tech News', emoji: '💻' },
      { label: 'Entertainment', emoji: '🎬' },
      { label: 'World News', emoji: '🌍' },
      { label: 'Economy & Business', emoji: '📈' },
      { label: 'Crime & Law', emoji: '⚖️' },
      { label: 'Health & Science', emoji: '🧬' }
    ];
    const data = await getLinks();
    data.links[pending.editIndex].headline = pending.newHeadline;
    if ('newImage' in pending) {
      if (pending.newImage === null) {
        delete data.links[pending.editIndex].image;
      } else {
        data.links[pending.editIndex].image = pending.newImage;
      }
    }
    if (text.toLowerCase() !== 'keep') {
      const num = parseInt(text.trim());
      if (isNaN(num) || num < 1 || num > 10) {
        bot.sendMessage(chatId, 'Please reply with a number between 1 and 10, or "keep".');
        return;
      }
      const chosen = categories[num - 1];
      data.links[pending.editIndex].category = chosen.label;
      data.links[pending.editIndex].emoji = chosen.emoji;
    }
    data.lastUpdated = new Date().toISOString();
    await saveLinks(data);
    await clearPending(userId);
    bot.sendMessage(chatId, 'Updated!\n\nOld: "' + pending.oldHeadline + '"\nNew: "' + pending.newHeadline + '"');
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
    const targetLink = data.links[num - 1];
    await savePending(userId, { step: 'awaiting_delete_confirm', deleteIndex: num - 1, headline: targetLink.headline });
    bot.sendMessage(chatId, 'Are you sure you want to delete:\n\n"' + targetLink.headline + '"\n\nReply "yes" to confirm or "cancel" to go back.');
    return;
  }

  // Awaiting delete confirmation
  if (pending.step === 'awaiting_delete_confirm') {
    if (text.toLowerCase() === 'yes') {
      const data = await getLinks();
      const removed = data.links.splice(pending.deleteIndex, 1)[0];
      data.lastUpdated = new Date().toISOString();
      await saveLinks(data);
      await clearPending(userId);
      bot.sendMessage(chatId, 'Deleted: ' + removed.headline);
    } else {
      await clearPending(userId);
      bot.sendMessage(chatId, 'Cancelled. Nothing was deleted.');
    }
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
    await savePending(userId, { ...pending, makeTop, step: 'awaiting_category' });
    const categoryMessage = 'Choose a category:\n\n' +
      '1. 🏦 US Politics\n' +
      '2. 📺 News Media\n' +
      '3. 🎭 Society & Culture\n' +
      '4. 🏆 Sports News\n' +
      '5. 💻 Tech News\n' +
      '6. 🎬 Entertainment\n' +
      '7. 🌍 World News\n' +
      '8. 📈 Economy & Business\n' +
      '9. ⚖️ Crime & Law\n' +
      '10. 🧬 Health & Science\n\n' +
      'Reply with a number.';
    bot.sendMessage(chatId, categoryMessage);
    return;
  }

  // Awaiting category
  if (pending.step === 'awaiting_category') {
    const categories = [
      { label: 'US Politics', emoji: '🏦' },
      { label: 'News Media', emoji: '📺' },
      { label: 'Society & Culture', emoji: '🎭' },
      { label: 'Sports News', emoji: '🏆' },
      { label: 'Tech News', emoji: '💻' },
      { label: 'Entertainment', emoji: '🎬' },
      { label: 'World News', emoji: '🌍' },
      { label: 'Economy & Business', emoji: '📈' },
      { label: 'Crime & Law', emoji: '⚖️' },
      { label: 'Health & Science', emoji: '🧬' }
    ];
    const num = parseInt(text.trim());
    if (isNaN(num) || num < 1 || num > 10) {
      bot.sendMessage(chatId, 'Please reply with a number between 1 and 10.');
      return;
    }
    const chosen = categories[num - 1];
    try {
      const data = await getLinks();
      const newLink = {
        headline: pending.headline,
        url: pending.url,
        category: chosen.label,
        emoji: chosen.emoji
      };
      if (pending.image) {
        newLink.image = pending.image;
      }
      if (pending.makeTop) {
        data.links.unshift(newLink);
      } else {
        data.links.push(newLink);
      }
      if (data.links.length > 50) {
        data.links = data.links.slice(0, 50);
      }
      data.lastUpdated = new Date().toISOString();
      await saveLinks(data);
      await clearPending(userId);
      console.log('Links saved successfully to Cloudflare KV');
      bot.sendMessage(chatId, 'Done! Posted under ' + chosen.emoji + ' ' + chosen.label + '.');
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
