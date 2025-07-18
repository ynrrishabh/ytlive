const express = require('express');
const { google } = require('googleapis');
const User = require('../models/User');
const botService = require('../bot/service');
const Bot = require('../models/Bot');
const router = express.Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Generate OAuth URL and redirect
router.get('/login', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  console.log('[AUTH] Redirecting user to Google OAuth');
  res.redirect(authUrl);
});

// Handle OAuth callback
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      throw new Error('No authorization code received');
    }

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.access_token) {
      throw new Error('No access token received');
    }
    
    oauth2Client.setCredentials(tokens);
    
    // Get channel info
    const youtube = google.youtube('v3');
    const response = await youtube.channels.list({
      auth: oauth2Client,
      part: 'snippet',
      mine: true
    });

    if (!response.data.items || response.data.items.length === 0) {
      throw new Error('No channel found for the authenticated user');
    }

    const channel = response.data.items[0];
    if (!channel.id) {
      throw new Error('Channel ID is missing');
    }
    
    // Save bot credentials
    await Bot.findOneAndUpdate(
      { botId: channel.id },
      {
        botId: channel.id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiry: new Date(tokens.expiry_date)
      },
      { upsert: true, new: true }
    );
    console.log(`[AUTH] Bot authenticated: ${channel.snippet.title} (${channel.id})`);

    // Restart bot service to use new credentials
    await botService.initBot();

    // Redirect to a simple success message
    res.send('<h1>Success!</h1><p>Bot has been authenticated and started monitoring channels. You can now close this window.</p>');
  } catch (error) {
    console.error('Auth callback error:', error);
    res.send(`<h1>Error</h1><p>Authentication failed: ${error.message}</p><p>Please try again.</p>`);
  }
});

module.exports = router; 