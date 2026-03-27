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

const CATEGORIES = [
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

const CATEGORY_MESSAGE = 'Choose a category:\n\n' +
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

const READY = '\n\nReady for next command.';

// Steps where the user may legitimately paste an image URL (not a new article URL)
const IMAGE_URL_STEPS = ['awaiting_custom_image', 'awaiting_edit_custom_image'];

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
    bot.sendMessage(chatId, 'No preview images found for this URL.\n\nSend me an image file, paste a direct image URL, or reply "skip" to use no image.');
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
  message += '\nOr reply:\n"upload" - Upload your own image\n"skip" - No image\nOr paste a direct image URL';
  bot.sendMessage(chatId, message);
}

async function showCategoryPrompt(chatId, userId, pending, prefixMessage) {
  const data = await getLinks();
  const currentCategory = pending.editIndex !== undefined ? data.links[pending.editIndex].category : null;
  const currentEmoji = pending.editIndex !== undefined ? data.links[pending.editIndex].emoji : null;
  const current = currentCategory ? currentEmoji + ' ' + currentCategory : 'None';
  const message = prefixMessage + ' Now choose a category' +
    (pending.editIndex !== undefined ? ' (current: ' + current + ')' : '') +
    ':\n\n' +
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
    'Reply with a number' +
    (pending.editIndex !== undefined ? ', or "keep" to leave unchanged.' : '.');
  bot.sendMessage(chatId, message);
}


// ── Source scrapers ──────────────────────────────────────────────

const SOURCES = [
  { name: 'Memeorandum', url: 'https://www.memeorandum.com', scrape: scrapeMemeorandum },
  { name: 'Techmeme',    url: 'https://www.techmeme.com',    scrape: scrapeTechmeme },
  { name: 'MediaGazer',  url: 'https://www.mediagazer.com',  scrape: scrapeMediaGazer },
  { name: 'Drudge',      url: 'https://www.drudgereport.com',scrape: scrapeDrudge },
  { name: 'NY Post',     url: 'https://nypost.com',          scrape: scrapeNYPost },
  { name: 'Deadline',    url: 'https://deadline.com',        scrape: scrapeDeadline },
  { name: 'ESPN',        url: 'https://www.espn.com',        scrape: scrapeESPN },
];

async function fetchPage(url) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    timeout: 10000
  });
  return cheerio.load(response.data);
}

async function scrapeMemeorandum() {
  const $ = await fetchPage('https://www.memeorandum.com');
  const results = [];
  $('h2 > a').each((i, el) => {
    if (results.length >= 3) return false;
    const headline = $(el).text().trim();
    const url = $(el).attr('href');
    if (headline && url && url.startsWith('http')) results.push({ headline, url });
  });
  return results;
}

async function scrapeTechmeme() {
  const $ = await fetchPage('https://www.techmeme.com');
  const results = [];
  $('h2 > a').each((i, el) => {
    if (results.length >= 2) return false;
    const headline = $(el).text().trim();
    const url = $(el).attr('href');
    if (headline && url && url.startsWith('http')) results.push({ headline, url });
  });
  return results;
}

async function scrapeMediaGazer() {
  const $ = await fetchPage('https://www.mediagazer.com');
  const results = [];
  $('h2 > a').each((i, el) => {
    if (results.length >= 2) return false;
    const headline = $(el).text().trim();
    const url = $(el).attr('href');
    if (headline && url && url.startsWith('http')) results.push({ headline, url });
  });
  return results;
}

async function scrapeDrudge() {
  const $ = await fetchPage('https://www.drudgereport.com');
  const results = [];
  // Drudge uses plain <a> tags in the main column
  $('a[href^="http"]').each((i, el) => {
    if (results.length >= 2) return false;
    const headline = $(el).text().trim();
    const url = $(el).attr('href');
    if (headline && headline.length > 20 && url && !url.includes('drudgereport.com')) {
      results.push({ headline, url });
    }
  });
  return results;
}

async function scrapeNYPost() {
  const $ = await fetchPage('https://nypost.com');
  const results = [];
  $('h3 a, h2 a').each((i, el) => {
    if (results.length >= 2) return false;
    const headline = $(el).text().trim();
    let url = $(el).attr('href');
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://nypost.com' + url;
    if (headline && headline.length > 15) results.push({ headline, url });
  });
  return results;
}

async function scrapeDeadline() {
  const $ = await fetchPage('https://deadline.com');
  const results = [];
  $('h2 a, h3 a').each((i, el) => {
    if (results.length >= 2) return false;
    const headline = $(el).text().trim();
    let url = $(el).attr('href');
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://deadline.com' + url;
    if (headline && headline.length > 15) results.push({ headline, url });
  });
  return results;
}

async function scrapeESPN() {
  const $ = await fetchPage('https://www.espn.com');
  const results = [];
  $('h1 a, h2 a, .contentItem__title a').each((i, el) => {
    if (results.length >= 2) return false;
    const headline = $(el).text().trim();
    let url = $(el).attr('href');
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://www.espn.com' + url;
    if (headline && headline.length > 15) results.push({ headline, url });
  });
  return results;
}

async function fetchTopStories(existingUrls) {
  const allResults = [];
  await Promise.allSettled(
    SOURCES.map(async source => {
      try {
        const stories = await source.scrape();
        stories.forEach(s => {
          if (!existingUrls.includes(s.url)) {
            allResults.push({ ...s, source: source.name });
          }
        });
      } catch (err) {
        console.log('Scrape failed for ' + source.name + ':', err.message);
      }
    })
  );
  // Limit to 10
  return allResults.slice(0, 10);
}


// ── Gemini headline generation ────────────────────────────────────

async function generateHeadlines(url) {
  try {
    // Fetch article text
    const pageResponse = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      timeout: 10000
    });
    const $ = cheerio.load(pageResponse.data);
    // Extract readable text: title + meta description + first 2000 chars of body text
    const title = $('title').text().trim();
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const bodyText = $('p').map((i, el) => $(el).text().trim()).get().join(' ').slice(0, 5000);
    const articleContent = [title, metaDesc, bodyText].filter(Boolean).join('\n\n');

    const systemPrompt = process.env.HEADLINE_PROMPT || 'You are a conservative news headline writer. Propose exactly 3 punchy conservative headlines. Return only a JSON array of 3 strings, nothing else.';

    const groqResponse = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Article content:\n' + articleContent }
        ],
        temperature: 0.8,
        max_tokens: 500
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
        },
        timeout: 15000
      }
    );

    const raw = groqResponse.data.choices[0].message.content.trim();
    console.log('Groq raw response:', raw);
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json|```/g, '').trim();
    // Extract JSON array even if there's surrounding text
    const match = cleaned.match(/\[.*\]/s);
    if (!match) throw new Error('No JSON array found in response');
    const headlines = JSON.parse(match[0]);
    if (!Array.isArray(headlines) || headlines.length === 0) throw new Error('Invalid response format');
    return headlines.slice(0, 3);
  } catch (err) {
    console.error('Groq headline error:', err.message);
    return null;
  }
}


async function triggerHeadlineGeneration(chatId, userId, pending) {
  await savePending(userId, { ...pending, step: 'generating_headlines' });
  bot.sendMessage(chatId, 'Generating headline options...');
  const headlines = await generateHeadlines(pending.url);
  if (!headlines) {
    await savePending(userId, { ...pending, step: 'awaiting_headline' });
    bot.sendMessage(chatId, 'Could not generate headlines. Send me a headline manually.');
    return;
  }
  await savePending(userId, { ...pending, aiHeadlines: headlines, step: 'awaiting_headline_choice' });
  let message = 'Here are 3 headline options:\n\n';
  headlines.forEach((h, i) => {
    message += (i + 1) + '. ' + h + '\n\n';
  });
  message += 'Reply with a number to use that headline, or type your own.';
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

  if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel') {
    await clearPending(userId);
    bot.sendMessage(chatId, 'Cancelled. Send a URL to get started.');
    return;
  }

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


  if (text.toLowerCase() === 'fetch' || text.toLowerCase() === '/fetch') {
    bot.sendMessage(chatId, 'Fetching top stories from across the web...');
    try {
      const data = await getLinks();
      const existingUrls = (data.links || []).map(l => l.url);
      const stories = await fetchTopStories(existingUrls);
      if (stories.length === 0) {
        bot.sendMessage(chatId, 'No new stories found. Try again later.');
        return;
      }
      await savePending(userId, { step: 'awaiting_fetch_choice', fetchedStories: stories });
      let message = 'Here are today\'s top stories:\n\n';
      stories.forEach((s, i) => {
        message += (i + 1) + '. [' + s.headline + '](' + s.url + ') — ' + s.source + '\n\n';
      });
      message += 'Reply with a number to add a story, or "cancel" to go back.';
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
      console.error('Fetch error:', err);
      bot.sendMessage(chatId, 'Something went wrong fetching stories. Try again.');
    }
    return;
  }

  // Only treat http input as a new article URL if the user isn't mid-flow on an image step
  if (text.startsWith('http')) {
    let existingStep = null;
    let pendingFetchFailed = false;
    try {
      const existingPending = await getPending(userId);
      existingStep = existingPending ? existingPending.step : null;
    } catch (err) {
      pendingFetchFailed = true;
      console.log('Could not check pending state:', err.message);
    }
    if (!pendingFetchFailed && !IMAGE_URL_STEPS.includes(existingStep)) {
      await savePending(userId, { url: text, step: 'fetching_images' });
      bot.sendMessage(chatId, 'Got the URL. Fetching preview images...');
      const images = await fetchImages(text);
      const pending = await getPending(userId);
      await presentImages(chatId, userId, images, pending);
      return;
    }
  }

  const pending = await getPending(userId);
  console.log('Retrieved pending state:', JSON.stringify(pending));

  if (!pending) {
    bot.sendMessage(chatId, 'Send me a URL to get started.');
    return;
  }

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

  if (pending.step === 'awaiting_delete_confirm') {
    if (text.toLowerCase() === 'yes') {
      const data = await getLinks();
      const removed = data.links.splice(pending.deleteIndex, 1)[0];
      data.lastUpdated = new Date().toISOString();
      await saveLinks(data);
      await clearPending(userId);
      bot.sendMessage(chatId, 'Deleted: ' + removed.headline + READY);
    } else {
      await clearPending(userId);
      bot.sendMessage(chatId, 'Cancelled. Nothing was deleted.' + READY);
    }
    return;
  }

  if (pending.step === 'awaiting_edit_choice') {
    const num = parseInt(text.trim());
    const data = await getLinks();
    if (isNaN(num) || num < 1 || num > data.links.length) {
      bot.sendMessage(chatId, 'Invalid number. Reply with a number from the list, or "cancel".');
      return;
    }
    const targetLink = data.links[num - 1];
    await savePending(userId, { step: 'awaiting_new_headline', editIndex: num - 1, oldHeadline: targetLink.headline });
    bot.sendMessage(chatId, 'Current headline:\n"' + targetLink.headline + '"\n\nSend me the new headline, or reply "keep" to leave it unchanged.');
    return;
  }

  if (pending.step === 'awaiting_new_headline') {
    if (text.toLowerCase() === 'keep') {
      await savePending(userId, { ...pending, newHeadline: pending.oldHeadline, step: 'awaiting_edit_image_choice' });
      const data = await getLinks();
      const currentImage = data.links[pending.editIndex].image;
      const current = currentImage ? 'Yes (image set)' : 'None';
      bot.sendMessage(chatId, 'Headline kept. Now what do you want to do with the image? (current: ' + current + ')\n\n' +
        '"keep" - Keep current image\n' +
        '"fetch" - Fetch new images from the URL\n' +
        '"upload" - Upload your own image\n' +
        '"link" - Paste a direct image URL\n' +
        '"remove" - Remove image entirely');
      return;
    }
    await savePending(userId, { ...pending, newHeadline: text, step: 'awaiting_edit_confirm' });
    bot.sendMessage(chatId, 'Are you sure you want to change:\n\nFrom: "' + pending.oldHeadline + '"\nTo: "' + text + '"\n\nReply "yes" to confirm or "cancel" to go back.');
    return;
  }

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
        '"link" - Paste a direct image URL\n' +
        '"remove" - Remove image entirely');
    } else {
      await clearPending(userId);
      bot.sendMessage(chatId, 'Cancelled. Headline was not changed.' + READY);
    }
    return;
  }

  if (pending.step === 'awaiting_edit_image_choice') {
    const choice = text.toLowerCase().trim();

    if (choice === 'keep') {
      await savePending(userId, { ...pending, step: 'awaiting_edit_category' });
      await showCategoryPrompt(chatId, userId, pending, 'Image kept.');
      return;
    }

    if (choice === 'remove') {
      await savePending(userId, { ...pending, newImage: null, step: 'awaiting_edit_category' });
      await showCategoryPrompt(chatId, userId, pending, 'Image removed.');
      return;
    }

    if (choice === 'fetch') {
      bot.sendMessage(chatId, 'Fetching images from URL...');
      const data = await getLinks();
      const url = data.links[pending.editIndex].url;
      const images = await fetchImages(url);
      if (images.length === 0) {
        await savePending(userId, { ...pending, step: 'awaiting_edit_custom_image' });
        bot.sendMessage(chatId, 'No preview images found.\n\nSend me an image file, paste a direct image URL, or reply "skip" to keep current image.');
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

    if (choice === 'link') {
      await savePending(userId, { ...pending, step: 'awaiting_edit_custom_image' });
      bot.sendMessage(chatId, 'Paste the direct image URL.');
      return;
    }

    bot.sendMessage(chatId, 'Please reply with "keep", "fetch", "upload", "link", or "remove".');
    return;
  }

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
    await showCategoryPrompt(chatId, userId, pending, 'Image updated.');
    return;
  }

  if (pending.step === 'awaiting_edit_custom_image') {
    if (text.toLowerCase() === 'skip') {
      await savePending(userId, { ...pending, step: 'awaiting_edit_category' });
      await showCategoryPrompt(chatId, userId, pending, 'Image kept.');
      return;
    }
    if (text.startsWith('http')) {
      await savePending(userId, { ...pending, newImage: text, step: 'awaiting_edit_category' });
      await showCategoryPrompt(chatId, userId, pending, 'Image URL saved.');
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
        await showCategoryPrompt(chatId, userId, pending, 'Image uploaded.');
      } catch (err) {
        console.error('Cloudinary upload error:', err);
        bot.sendMessage(chatId, 'Image upload failed. Try again or reply "skip".');
      }
      return;
    }
    bot.sendMessage(chatId, 'Please send an image file, paste a direct image URL, or reply "skip".');
    return;
  }

  if (pending.step === 'awaiting_edit_category') {
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
      const chosen = CATEGORIES[num - 1];
      data.links[pending.editIndex].category = chosen.label;
      data.links[pending.editIndex].emoji = chosen.emoji;
    }
    data.lastUpdated = new Date().toISOString();
    await saveLinks(data);
    await clearPending(userId);
    bot.sendMessage(chatId, 'Updated!\n\nOld: "' + pending.oldHeadline + '"\nNew: "' + pending.newHeadline + '"' + READY);
    return;
  }

  if (pending.step === 'awaiting_image_choice') {
    const choice = text.trim();

    if (choice === 'skip') {
      const updatedPending1 = { ...pending, image: null };
      await triggerHeadlineGeneration(chatId, userId, updatedPending1);
      return;
    }

    if (choice === 'upload') {
      await savePending(userId, { ...pending, step: 'awaiting_custom_image' });
      bot.sendMessage(chatId, 'Send me the image you want to upload.');
      return;
    }

    if (choice.startsWith('http')) {
      const updatedPending2 = { ...pending, image: choice };
      await triggerHeadlineGeneration(chatId, userId, updatedPending2);
      return;
    }

    const num = parseInt(choice);
    if (!isNaN(num) && num >= 1 && num <= pending.availableImages.length) {
      const chosenImage = pending.availableImages[num - 1];
      const updatedPending3 = { ...pending, image: chosenImage };
      await triggerHeadlineGeneration(chatId, userId, updatedPending3);
      return;
    }

    bot.sendMessage(chatId, 'Please reply with a number, "upload", "skip", or paste a direct image URL.');
    return;
  }

  if (pending.step === 'awaiting_custom_image') {
    if (text.toLowerCase() === 'skip') {
      const updatedPending6 = { ...pending, image: null };
      await triggerHeadlineGeneration(chatId, userId, updatedPending6);
      return;
    }
    if (text.startsWith('http')) {
      const updatedPending4 = { ...pending, image: text };
      await triggerHeadlineGeneration(chatId, userId, updatedPending4);
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
        const updatedPending5 = { ...pending, image: uploadResult.secure_url };
        await triggerHeadlineGeneration(chatId, userId, updatedPending5);
      } catch (err) {
        console.error('Cloudinary upload error:', err);
        bot.sendMessage(chatId, 'Image upload failed. Try again or reply "skip".');
      }
      return;
    }
    bot.sendMessage(chatId, 'Please send an image file, paste a direct image URL, or reply "skip".');
    return;
  }

  if (pending.step === 'awaiting_headline') {
    // Fallback: manual headline entry (AI generation failed)
    await savePending(userId, { ...pending, headline: text, step: 'awaiting_position' });
    bot.sendMessage(chatId, 'Where do you want to place this?\n\n"yes" - Top Headline\n"1" - Sub-Headlines (image row)\n"2" - Link Only Headlines');
    return;
  }

  if (pending.step === 'awaiting_headline_choice') {
    const num = parseInt(text.trim());
    let chosenHeadline;
    if (!isNaN(num) && num >= 1 && num <= pending.aiHeadlines.length) {
      chosenHeadline = pending.aiHeadlines[num - 1];
    } else if (text.trim().length > 3) {
      // User typed their own headline
      chosenHeadline = text.trim();
    } else {
      bot.sendMessage(chatId, 'Reply with a number to choose a headline, or type your own.');
      return;
    }
    await savePending(userId, { ...pending, headline: chosenHeadline, step: 'awaiting_position' });
    bot.sendMessage(chatId, 'Where do you want to place this?\n\n"yes" - Top Headline\n"1" - Sub-Headlines (image row)\n"2" - Link Only Headlines');
    return;
  }

  if (pending.step === 'awaiting_position') {
    const choice = text.trim().toLowerCase();
    if (choice !== 'yes' && choice !== '1' && choice !== '2') {
      bot.sendMessage(chatId, 'Please reply "yes" (Top Headline), "1" (Sub-Headlines), or "2" (Link Only Headlines).');
      return;
    }
    await savePending(userId, { ...pending, position: choice, step: 'awaiting_category' });
    bot.sendMessage(chatId, CATEGORY_MESSAGE);
    return;
  }

  if (pending.step === 'awaiting_category') {
    const num = parseInt(text.trim());
    if (isNaN(num) || num < 1 || num > 10) {
      bot.sendMessage(chatId, 'Please reply with a number between 1 and 10.');
      return;
    }
    const chosen = CATEGORIES[num - 1];
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
      if (pending.position === 'yes') {
        // Top Headline — insert at front
        data.links.unshift(newLink);
      } else if (pending.position === '1') {
        // Sub-Headlines — insert at index 1 (right after top story)
        // If there are already 3 sub-headlines (indices 1-3), the one at index 3
        // gets pushed to index 4 automatically by splice, becoming first Link Only
        data.links.splice(1, 0, newLink);
      } else {
        // Link Only Headlines — insert at index 4 (first text link slot)
        const insertAt = Math.min(4, data.links.length);
        data.links.splice(insertAt, 0, newLink);
      }
      if (data.links.length > 50) {
        data.links = data.links.slice(0, 50);
      }
      data.lastUpdated = new Date().toISOString();
      await saveLinks(data);
      await clearPending(userId);
      console.log('Links saved successfully to Cloudflare KV');
      const sectionName = pending.position === 'yes' ? 'Top Headline' : pending.position === '1' ? 'Sub-Headlines' : 'Link Only Headlines';
      bot.sendMessage(chatId, 'Done! Added to ' + sectionName + '.' + READY);
    } catch (err) {
      bot.sendMessage(chatId, 'Something went wrong updating the site. Try again.');
      console.error('Error saving links:', err);
    }
    return;
  }


  if (pending.step === 'awaiting_fetch_choice') {
    const num = parseInt(text.trim());
    if (isNaN(num) || num < 1 || num > pending.fetchedStories.length) {
      bot.sendMessage(chatId, 'Please reply with a number from the list, or "cancel".');
      return;
    }
    const chosen = pending.fetchedStories[num - 1];
    await savePending(userId, { url: chosen.url, step: 'fetching_images' });
    bot.sendMessage(chatId, 'Got it. Fetching preview images for:\n"' + chosen.headline + '"');
    const images = await fetchImages(chosen.url);
    const updatedPending = await getPending(userId);
    await presentImages(chatId, userId, images, updatedPending);
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
