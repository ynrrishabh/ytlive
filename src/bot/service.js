const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const User = require('../models/User');
const Viewer = require('../models/Viewer');
const cron = require('node-cron');
const Bot = require('../models/Bot');
const Channel = require('../models/Channel');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

class BotService {
  constructor() {
    this.activeStreams = new Map(); // channelId -> { liveChatId, nextPageToken }
    this.autoMessageTimers = new Map(); // channelId -> timer
    this.liveCheckTasks = new Map(); // channelId -> cron task
    this.lastMessageTimestamps = new Map(); // channelId -> timestamp
    this.initBot();
  }

  async initBot() {
    try {
      // Get bot credentials
      const bot = await Bot.findOne({});
      if (!bot) {
        console.log('[BOT] No bot credentials found. Please authenticate bot first.');
        return;
      }

      // Get all channels to monitor
      const channels = await Channel.find({});
      console.log(`[BOT] Found ${channels.length} channels to monitor`);

      // Start monitoring each channel
      for (const channel of channels) {
        console.log(`[BOT] Starting monitoring for channel: ${channel.channelId}`);
        this.checkAndStartLive(channel.channelId);
      }

      // Start cron job for continuous monitoring
      this.initLiveDetection();
    } catch (error) {
      console.error('[BOT] Error initializing bot:', error);
    }
  }

  // Periodically check for live streams for all users
  initLiveDetection() {
    // Run every 1 minute
    cron.schedule('*/1 * * * *', async () => {
      try {
        const users = await User.find({});
        for (const user of users) {
          const lastMsg = this.lastMessageTimestamps.get(user.channelId);
          const now = Date.now();
          if (!lastMsg || now - lastMsg > 35 * 60 * 1000) {
            console.log(`[BOT][INACTIVITY] No message for 35min (or never) in channel ${user.channelId}, checking live...`);
            this.checkAndStartLive(user.channelId);
          } else {
            console.log(`[BOT][INACTIVITY] Channel ${user.channelId} is active, last message ${Math.round((now - lastMsg)/60000)} min ago.`);
          }
        }
      } catch (err) {
        console.error('[BOT] Error in live detection cron:', err);
      }
    });
    console.log('[BOT] Live detection cron job started (every 1 minute, inactivity-aware)');
  }

  async checkAndStartLive(channelId) {
    try {
      // Get bot credentials
      const bot = await Bot.findOne({});
      if (!bot) {
        console.log(`[BOT] No bot credentials found. Please authenticate bot first.`);
        return;
      }

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        access_token: bot.accessToken,
        refresh_token: bot.refreshToken
      });

      const youtube = google.youtube('v3');
      
      // First, search for live streams on the target channel
      const searchResponse = await youtube.search.list({
        auth: oauth2Client,
        part: 'id',
        channelId: channelId,
        eventType: 'live',
        type: 'video'
      });

      if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
        console.log(`[BOT] No live stream found for channel: ${channelId}`);
        if (this.activeStreams.has(channelId)) {
          console.log(`[BOT] Stopping bot for channel: ${channelId}`);
          this.stopBot(channelId);
        }
        return;
      }

      // Get live stream details
      const videoId = searchResponse.data.items[0].id.videoId;
      const videoResponse = await youtube.videos.list({
        auth: oauth2Client,
        part: 'liveStreamingDetails',
        id: videoId
      });

      if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
        console.log(`[BOT] Could not get live stream details for channel: ${channelId}`);
        return;
      }

      const liveChatId = videoResponse.data.items[0].liveStreamingDetails.activeLiveChatId;
      
      if (liveChatId && !this.activeStreams.has(channelId)) {
        console.log(`[BOT] Found live stream for channel: ${channelId}`);
        await this.startBot(channelId, true, { snippet: { liveChatId } });
      }
    } catch (err) {
      console.error(`[BOT] Error checking live for channel ${channelId}:`, err);
    }
  }

  async startBot(channelId, fromLiveDetection = false, liveBroadcast = null) {
    try {
      // Get bot credentials
      const bot = await Bot.findOne({});
      if (!bot) throw new Error('Bot credentials not found');

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        access_token: bot.accessToken,
        refresh_token: bot.refreshToken
      });

      const youtube = google.youtube('v3');
      let liveChatId;

      if (liveBroadcast) {
        liveChatId = liveBroadcast.snippet.liveChatId;
      } else {
        // Search for live stream if not provided
        const searchResponse = await youtube.search.list({
          auth: oauth2Client,
          part: 'id',
          channelId: channelId,
          eventType: 'live',
          type: 'video'
        });

        if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
          console.log(`[BOT] No active stream found for channel: ${channelId}`);
          return false;
        }

        const videoId = searchResponse.data.items[0].id.videoId;
        const videoResponse = await youtube.videos.list({
          auth: oauth2Client,
          part: 'liveStreamingDetails',
          id: videoId
        });

        if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
          console.log(`[BOT] Could not get live stream details for channel: ${channelId}`);
          return false;
        }

        liveChatId = videoResponse.data.items[0].liveStreamingDetails.activeLiveChatId;
      }

      this.activeStreams.set(channelId, { liveChatId, nextPageToken: null });
      console.log(`[BOT] Started for channel: ${channelId}, liveChatId: ${liveChatId}`);
      
      // Start polling chat
      this.pollChat(channelId, oauth2Client);
      
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

  async pollChat(channelId, oauth2Client, pollInterval = 3000, errorCount = 0) {
    const stream = this.activeStreams.get(channelId);
    if (!stream) return;
    try {
      const youtube = google.youtube('v3');
      // Use fields to minimize quota usage
      const response = await youtube.liveChatMessages.list({
        auth: oauth2Client,
        liveChatId: stream.liveChatId,
        part: 'snippet,authorDetails',
        pageToken: stream.nextPageToken,
        fields: 'items(snippet(displayMessage),authorDetails(displayName,channelId)),nextPageToken,pollingIntervalMillis'
      });
      stream.nextPageToken = response.data.nextPageToken;
      // Process messages
      let messageCount = 0;
      for (const item of response.data.items) {
        await this.processMessage(channelId, item);
        messageCount++;
      }
      // Use YouTube's suggested polling interval if available
      let nextInterval = response.data.pollingIntervalMillis || pollInterval;
      // If no messages, increase interval up to 10s, else reset to 3s
      if (messageCount === 0) {
        nextInterval = Math.min(nextInterval + 1000, 10000);
      } else {
        nextInterval = 3000;
      }
      setTimeout(() => this.pollChat(channelId, oauth2Client, nextInterval, 0), nextInterval);
    } catch (error) {
      console.error('[BOT] Error polling chat:', error);
      // Exponential backoff on error, up to 60s
      const nextInterval = Math.min(3000 * Math.pow(2, errorCount), 60000);
      setTimeout(() => this.pollChat(channelId, oauth2Client, nextInterval, errorCount + 1), nextInterval);
    }
  }

  async processMessage(channelId, message) {
    try {
      if (!message || !message.snippet || !message.snippet.displayMessage) {
        console.log('[BOT][DEBUG] Skipping message with missing snippet/displayMessage:', message);
        return;
      }
      // Update last message timestamp
      this.lastMessageTimestamps.set(channelId, Date.now());
      const { snippet, authorDetails } = message;
      const text = snippet.displayMessage.toLowerCase();
      // Update viewer stats
      await this.updateViewerStats(channelId, authorDetails);
      // Handle commands
      if (text.startsWith('!') || text.startsWith('/')) {
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
      await Channel.findOneAndUpdate(
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
      console.log(`[BOT][DEBUG][GEMINI] Gemini response for /ask:`, text);
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
      const bot = await Bot.findOne({ botId: channelId });
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        access_token: bot.accessToken,
        refresh_token: bot.refreshToken
      });
      const youtube = google.youtube('v3');
      console.log(`[BOT][DEBUG] Sending message to liveChatId for channel ${channelId}: ${stream.liveChatId}`);
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
    const timer = setInterval(async () => {
      // Only send auto-message if there was chat activity in the last 10 minutes
      const lastMsg = this.lastMessageTimestamps.get(channelId);
      if (!lastMsg || Date.now() - lastMsg > 10 * 60 * 1000) {
        console.log(`[BOT] Skipping auto-message for channel: ${channelId} due to inactivity.`);
        return;
      }
      await this.sendMessage(channelId, text);
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