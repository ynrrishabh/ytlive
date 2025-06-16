const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const User = require('../models/User');
const Viewer = require('../models/Viewer');
const cron = require('node-cron');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

class BotService {
  constructor() {
    this.activeStreams = new Map(); // channelId -> { liveChatId, nextPageToken }
    this.autoMessageTimers = new Map(); // channelId -> timer
    this.liveCheckTasks = new Map(); // channelId -> cron task
    this.initLiveDetection();
  }

  // Periodically check for live streams for all users
  initLiveDetection() {
    // Run every 1 minute
    cron.schedule('*/1 * * * *', async () => {
      try {
        const users = await User.find({});
        for (const user of users) {
          this.checkAndStartLive(user.channelId);
        }
      } catch (err) {
        console.error('[BOT] Error in live detection cron:', err);
      }
    });
    console.log('[BOT] Live detection cron job started (every 1 minute)');
  }

  async checkAndStartLive(channelId) {
    try {
      const user = await User.findOne({ channelId });
      if (!user) return;
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        access_token: user.accessToken,
        refresh_token: user.refreshToken
      });
      const youtube = google.youtube('v3');
      const response = await youtube.liveBroadcasts.list({
        auth: oauth2Client,
        part: 'snippet',
        mine: true
      });
      const liveBroadcast = response.data.items && response.data.items.find(
        b => b.snippet && b.snippet.liveBroadcastContent === 'live'
      );
      if (liveBroadcast) {
        if (!this.activeStreams.has(channelId)) {
          console.log(`[BOT] Detected live stream for channel: ${channelId}`);
          await this.startBot(channelId, true, liveBroadcast);
        }
      } else {
        // Always log when checked, even if no live
        console.log(`[BOT] Checked channel: ${channelId} - No live stream found.`);
        if (this.activeStreams.has(channelId)) {
          console.log(`[BOT] No active stream found for channel: ${channelId}, stopping bot.`);
          this.stopBot(channelId);
        }
      }
    } catch (err) {
      console.error(`[BOT] Error checking live for channel ${channelId}:`, err);
    }
  }

  async startBot(channelId, fromLiveDetection = false, liveBroadcast = null) {
    try {
      const user = await User.findOne({ channelId });
      if (!user) throw new Error('User not found');
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        access_token: user.accessToken,
        refresh_token: user.refreshToken
      });
      const youtube = google.youtube('v3');
      // Remove broadcastStatus, use mine:true and filter in code
      let liveChatId;
      if (liveBroadcast) {
        liveChatId = liveBroadcast.snippet.liveChatId;
      } else {
        const response = await youtube.liveBroadcasts.list({
          auth: oauth2Client,
          part: 'snippet',
          mine: true
        });
        const found = response.data.items && response.data.items.find(
          b => b.snippet && b.snippet.liveBroadcastContent === 'live'
        );
        if (!found) {
          console.log(`[BOT] No active stream found for channel: ${channelId}`);
          return false;
        }
        liveChatId = found.snippet.liveChatId;
      }
      this.activeStreams.set(channelId, { liveChatId, nextPageToken: null });
      console.log(`[BOT] Started for channel: ${channelId}, liveChatId: ${liveChatId}`);
      // Start polling chat
      this.pollChat(channelId, oauth2Client);
      // Setup auto message if enabled
      if (user.autoMessage.enabled) {
        this.setupAutoMessage(channelId, user.autoMessage);
      }
      // If started from live detection, send "I am ON!" message
      if (fromLiveDetection) {
        await this.sendMessage(channelId, 'I am ON!');
        console.log(`[BOT] Sent 'I am ON!' message to channel: ${channelId}`);
      }
      return true;
    } catch (error) {
      console.error('[BOT] Error starting bot:', error);
      return false;
    }
  }

  async pollChat(channelId, oauth2Client) {
    const stream = this.activeStreams.get(channelId);
    if (!stream) return;
    try {
      const youtube = google.youtube('v3');
      const response = await youtube.liveChatMessages.list({
        auth: oauth2Client,
        liveChatId: stream.liveChatId,
        part: 'snippet',
        pageToken: stream.nextPageToken
      });
      stream.nextPageToken = response.data.nextPageToken;
      // Process messages
      for (const item of response.data.items) {
        await this.processMessage(channelId, item);
      }
      // Schedule next poll
      setTimeout(() => this.pollChat(channelId, oauth2Client), 3000);
    } catch (error) {
      console.error('[BOT] Error polling chat:', error);
      this.activeStreams.delete(channelId);
    }
  }

  async processMessage(channelId, message) {
    try {
      const { authorDetails, snippet } = message.snippet;
      const text = snippet.displayMessage.toLowerCase();
      // Update viewer stats
      await this.updateViewerStats(channelId, authorDetails);
      // Handle commands
      if (text.startsWith('!')) {
        await this.handleCommand(channelId, authorDetails, text);
      }
      console.log(`[BOT] Processed message from ${authorDetails.displayName} in channel ${channelId}: ${text}`);
    } catch (error) {
      console.error('[BOT] Error processing message:', error);
    }
  }

  async updateViewerStats(channelId, authorDetails) {
    try {
      const { channelId: viewerId, displayName } = authorDetails;
      await Viewer.findOneAndUpdate(
        { channelId, viewerId },
        {
          channelId,
          viewerId,
          username: displayName,
          $inc: { points: 1, watchTime: 1 },
          lastActive: new Date()
        },
        { upsert: true }
      );
      console.log(`[BOT] Updated stats for viewer ${displayName} (${viewerId}) in channel ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error updating viewer stats:', error);
    }
  }

  async handleCommand(channelId, author, text) {
    try {
      const [command, ...args] = text.slice(1).split(' ');
      switch (command) {
        case 'points':
          await this.handlePointsCommand(channelId, author);
          break;
        case 'roll':
        case 'gamble':
          await this.handleGambleCommand(channelId, author, args[0]);
          break;
        case 'ask':
          await this.handleAskCommand(channelId, author, args.join(' '));
          break;
      }
      console.log(`[BOT] Handled command '${command}' from ${author.displayName} in channel ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error handling command:', error);
    }
  }

  async handlePointsCommand(channelId, author) {
    try {
      const viewer = await Viewer.findOne({
        channelId,
        viewerId: author.channelId
      });
      if (viewer) {
        await this.sendMessage(channelId, `${author.displayName} has ${viewer.points} points and has watched for ${viewer.watchTime} minutes!`);
        console.log(`[BOT] Sent points message to ${author.displayName} in channel ${channelId}`);
      }
    } catch (error) {
      console.error('[BOT] Error handling points command:', error);
    }
  }

  async handleGambleCommand(channelId, author, amount) {
    try {
      const points = parseInt(amount);
      if (isNaN(points) || points <= 0) {
        await this.sendMessage(channelId, `${author.displayName}, please specify a valid amount of points to gamble!`);
        return;
      }
      const viewer = await Viewer.findOne({
        channelId,
        viewerId: author.channelId
      });
      if (!viewer || viewer.points < points) {
        await this.sendMessage(channelId, `${author.displayName}, you don't have enough points!`);
        return;
      }
      const win = Math.random() > 0.5;
      const pointsChange = win ? points : -points;
      await Viewer.findOneAndUpdate(
        { channelId, viewerId: author.channelId },
        { $inc: { points: pointsChange } }
      );
      await this.sendMessage(
        channelId,
        `${author.displayName} ${win ? 'won' : 'lost'} ${points} points!`
      );
      console.log(`[BOT] Processed gamble for ${author.displayName} in channel ${channelId}: ${win ? 'won' : 'lost'} ${points}`);
    } catch (error) {
      console.error('[BOT] Error handling gamble command:', error);
    }
  }

  async handleAskCommand(channelId, author, question) {
    try {
      if (!question) {
        await this.sendMessage(channelId, `${author.displayName}, please provide a question!`);
        return;
      }
      const model = genAI.getGenerativeModel({ model: "gemini-pro" });
      const result = await model.generateContent(question);
      const response = await result.response;
      const text = response.text();
      await this.sendMessage(channelId, `${author.displayName}, ${text}`);
      console.log(`[BOT] Sent AI response to ${author.displayName} in channel ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error handling ask command:', error);
      await this.sendMessage(channelId, `${author.displayName}, sorry, I couldn't process your question.`);
    }
  }

  async sendMessage(channelId, text) {
    const stream = this.activeStreams.get(channelId);
    if (!stream) return;
    try {
      const user = await User.findOne({ channelId });
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        access_token: user.accessToken,
        refresh_token: user.refreshToken
      });
      const youtube = google.youtube('v3');
      await youtube.liveChatMessages.insert({
        auth: oauth2Client,
        part: 'snippet',
        requestBody: {
          snippet: {
            liveChatId: stream.liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: {
              messageText: text
            }
          }
        }
      });
      console.log(`[BOT] Sent message: "${text}" to channel: ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error sending message:', error);
    }
  }

  setupAutoMessage(channelId, { text, interval }) {
    if (this.autoMessageTimers.has(channelId)) {
      clearInterval(this.autoMessageTimers.get(channelId));
    }
    const timer = setInterval(() => {
      this.sendMessage(channelId, text);
    }, interval * 60 * 1000);
    this.autoMessageTimers.set(channelId, timer);
    console.log(`[BOT] Auto message set up for channel: ${channelId} every ${interval} minutes`);
  }

  stopBot(channelId) {
    this.activeStreams.delete(channelId);
    if (this.autoMessageTimers.has(channelId)) {
      clearInterval(this.autoMessageTimers.get(channelId));
      this.autoMessageTimers.delete(channelId);
    }
    console.log(`[BOT] Stopped for channel: ${channelId}`);
  }
}

module.exports = new BotService(); 