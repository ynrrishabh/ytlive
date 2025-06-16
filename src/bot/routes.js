const express = require('express');
const router = express.Router();
const botService = require('./service');
const User = require('../models/User');

// Start the bot for a channel
router.post('/start/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const success = await botService.startBot(channelId);
    
    if (success) {
      res.json({ message: 'Bot started successfully' });
    } else {
      res.status(400).json({ error: 'Failed to start bot' });
    }
  } catch (error) {
    console.error('Error starting bot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop the bot for a channel
router.post('/stop/:channelId', (req, res) => {
  try {
    const { channelId } = req.params;
    botService.stopBot(channelId);
    res.json({ message: 'Bot stopped successfully' });
  } catch (error) {
    console.error('Error stopping bot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Configure auto message
router.post('/auto-message/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { text, interval, enabled } = req.body;

    const user = await User.findOneAndUpdate(
      { channelId },
      {
        'autoMessage.text': text,
        'autoMessage.interval': interval,
        'autoMessage.enabled': enabled
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (enabled) {
      botService.setupAutoMessage(channelId, { text, interval });
    } else {
      botService.stopBot(channelId);
    }

    res.json({ message: 'Auto message configured successfully' });
  } catch (error) {
    console.error('Error configuring auto message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get leaderboard
router.get('/leaderboard/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { type = 'points', limit = 10 } = req.query;

    const sortField = type === 'watchTime' ? 'watchTime' : 'points';
    
    const leaderboard = await Viewer.find({ channelId })
      .sort({ [sortField]: -1 })
      .limit(parseInt(limit))
      .select('username points watchTime');

    res.json({ leaderboard });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router; 