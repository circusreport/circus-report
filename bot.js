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


// ── Source scrapers (RSS-based) ──────────────────────────────────

const FEEDS = [
  // Conservative & independent outlets
  { name: 'NY Post',              url: 'https://nypost.com/feed/',                                        max: 2 },
  { name: 'NY Post Politics',     url: 'https://nypost.com/politics/feed/',                               max: 2 },
  { name: 'Fox News',             url: 'https://moxie.foxnews.com/google-publisher/latest.xml',           max: 2 },
  { name: 'Washington Examiner',  url: 'https://www.washingtonexaminer.com/feed',                         max: 2 },
  { name: 'Breitbart',            url: 'https://feeds.feedburner.com/breitbart',                          max: 2 },
  { name: 'Daily Wire',           url: 'https://www.dailywire.com/feeds/rss.xml',                         max: 2 },
  { name: 'Just the News',        url: 'https://justthenews.com/feed',                                    max: 2 },
  { name: 'The Federalist',       url: 'https://thefederalist.com/feed/',                                 max: 2 },
  { name: 'Daily Caller',         url: 'https://dailycaller.com/feed/',                                   max: 2 },
  { name: 'The Hill',             url: 'https://thehill.com/feed/',                                       max: 2 },
  // Entertainment
  { name: 'Deadline',             url: 'https://deadline.com/feed/',                                      max: 2 },
  { name: 'The Wrap',             url: 'https://www.thewrap.com/feed/',                                   max: 2 },
  { name: 'Variety',              url: 'https://variety.com/feed/',                                       max: 2 },
  // Tech
  { name: 'TechCrunch',           url: 'https://techcrunch.com/feed/',                                    max: 2 },
  // Sports
  { name: 'ESPN',                 url: 'https://www.espn.com/espn/rss/news',                              max: 2 },
  // Wire services — broad general coverage
  { name: 'AP News',              url: 'https://feeds.apnews.com/rss/topnews',                            max: 2 },
  { name: 'Reuters',              url: 'https://feeds.reuters.com/reuters/topNews',                       max: 2 },
  { name: 'NBC News',             url: 'https://feeds.nbcnews.com/nbcnews/public/news',                   max: 2 },
];

async function parseFeed(feedUrl, max) {
  const response = await axios.get(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RSS reader)',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    },
    timeout: 10000
  });
  const $ = cheerio.load(response.data, { xmlMode: true });
  const results = [];
  $('item').each((i, el) => {
    if (results.length >= max) return false;
    const headline = $(el).find('title').first().text().trim()
      .replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const url = ($(el).find('link').first().text().trim() ||
                 $(el).find('guid').first().text().trim()).trim();
    if (!headline || !url) return;
    if (!url.startsWith('http')) return;
    if (headline.length < 15 || headline.length > 250) return;
    results.push({ headline, url });
  });
  return results;
}

async function fetchTopStories(existingUrls) {
  const allResults = [];
  await Promise.allSettled(
    FEEDS.map(async feed => {
      try {
        const stories = await parseFeed(feed.url, feed.max);
        const filtered = stories.filter(s => !existingUrls.includes(s.url));
        console.log(feed.name + ': ' + filtered.length + ' stories');
        filtered.forEach(s => allResults.push({ ...s, source: feed.name }));
      } catch (err) {
        console.log('Feed failed for ' + feed.name + ':', err.message);
      }
    })
  );
  // Deduplicate by URL across all feeds
  const seen = new Set();
  const deduped = allResults.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
  console.log('Total stories after dedup: ' + deduped.length);
  return deduped;
}


// ── Gemini headline generation ────────────────────────────────────

async function generateHeadlines(url, fallbackHeadline) {
  try {
    // Try to fetch article text — fall back gracefully if blocked
    let articleContent = '';
    try {
      const pageResponse = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        timeout: 10000
      });
      const $ = cheerio.load(pageResponse.data);
      const title = $('title').text().trim();
      const metaDesc = $('meta[name="description"]').attr('content') || '';
      const bodyText = $('p').map((i, el) => $(el).text().trim()).get().join(' ').slice(0, 5000);
      articleContent = [title, metaDesc, bodyText].filter(Boolean).join('\n\n');
    } catch (fetchErr) {
      console.log('Page fetch failed, using URL and headline only:', fetchErr.message);
      articleContent = 'URL: ' + url + (fallbackHeadline ? '\nOriginal headline: ' + fallbackHeadline : '');
    }

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
  const headlines = await generateHeadlines(pending.url, pending.originalHeadline || null);
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
      const allStories = await fetchTopStories(existingUrls);
      if (allStories.length === 0) {
        bot.sendMessage(chatId, 'No new stories found. Try again later.');
        return;
      }
      const page = 0;
      const pageSize = 20;
      const shown = allStories.slice(0, pageSize);
      await savePending(userId, { step: 'awaiting_fetch_choice', fetchedStories: allStories, fetchPage: page });
      let message = 'Here are today\'s top stories (1-' + shown.length + ' of ' + allStories.length + '):\n\n';
      shown.forEach((s, i) => {
        message += (i + 1) + '. [' + s.headline + '](' + s.url + ') — ' + s.source + '\n\n';
      });
      message += 'Reply with a number to add a story, "more" for next batch, or "cancel" to go back.';
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
      console.error('Fetch error:', err);
      bot.sendMessage(chatId, 'Something went wrong fetching stories. Try again.');
    }
    return;
  }

  // Load pending state once and reuse throughout
  let pending = null;
  try {
    pending = await getPending(userId);
  } catch (err) {
    console.log('Could not load pending state:', err.message);
  }
  console.log('Retrieved pending state:', JSON.stringify(pending));

  // Handle http URLs
  if (text.startsWith('http')) {
    const currentStep = pending ? pending.step : null;
    const isImageStep = IMAGE_URL_STEPS.includes(currentStep);

    // Detect likely image URLs by extension or known image CDN patterns
    const imagePatterns = [
      /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?.*)?$/i,
      /\/image\//i, /\/images\//i, /\/img\//i,
      /\/uploads\//i, /\/media\//i, /\/photos\//i,
      /\/wp-content\//i, /\/static\//i,
      /cloudinary\.com/i, /imgix\.net/i, /amazonaws\.com.*\.(jpg|jpeg|png|webp)/i,
      /s\.yimg\.com/i, /media-cldnry/i, /nbcnews\.com\/image/i,
    ];
    const looksLikeImage = imagePatterns.some(p => p.test(text));

    if (isImageStep || looksLikeImage) {
      // Treat as image URL — fall through to pending step handlers below
    } else {
      await savePending(userId, { url: text, step: 'fetching_images' });
      bot.sendMessage(chatId, 'Got the URL. Fetching preview images...');
      const images = await fetchImages(text);
      const freshPending = await getPending(userId);
      await presentImages(chatId, userId, images, freshPending);
      return;
    }
  }

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
    const pageSize = 20;

    // Handle 'more'
    if (text.trim().toLowerCase() === 'more') {
      const nextPage = (pending.fetchPage || 0) + 1;
      const start = nextPage * pageSize;
      const shown = pending.fetchedStories.slice(start, start + pageSize);
      if (shown.length === 0) {
        bot.sendMessage(chatId, 'No more stories. Reply with a number to add one, or "cancel".');
        return;
      }
      await savePending(userId, { ...pending, fetchPage: nextPage });
      const total = pending.fetchedStories.length;
      const end = Math.min(start + pageSize, total);
      let message = 'More stories (' + (start + 1) + '-' + end + ' of ' + total + '):\n\n';
      shown.forEach((s, i) => {
        message += (start + i + 1) + '. [' + s.headline + '](' + s.url + ') — ' + s.source + '\n\n';
      });
      const hasMore = end < total;
      message += 'Reply with a number to add a story' + (hasMore ? ', "more" for next batch' : '') + ', or "cancel" to go back.';
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      return;
    }

    const num = parseInt(text.trim());
    if (isNaN(num) || num < 1 || num > pending.fetchedStories.length) {
      bot.sendMessage(chatId, 'Please reply with a number from the list, "more" for more stories, or "cancel".');
      return;
    }
    const chosen = pending.fetchedStories[num - 1];
    await savePending(userId, { url: chosen.url, originalHeadline: chosen.headline, step: 'fetching_images' });
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
