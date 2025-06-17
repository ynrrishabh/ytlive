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
    this.pollIntervals = new Map(); // channelId -> pollInterval
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
        console.log('[BOT] Running scheduled live check...');
        const channels = await Channel.find({});
        console.log(`[BOT] Checking ${channels.length} channels for live streams...`);
        
        for (const channel of channels) {
          // Skip check if channel is already being monitored
          if (this.activeStreams.has(channel.channelId)) {
            console.log(`[BOT] Channel ${channel.channelId} is already being monitored, skipping check...`);
            continue;
          }
          console.log(`[BOT] Checking if channel ${channel.channelId} is live...`);
          await this.checkAndStartLive(channel.channelId);
        }
      } catch (err) {
        console.error('[BOT] Error in live detection cron:', err);
      }
    });
    console.log('[BOT] Live detection cron job started (every 1 minute)');
  }

  async checkAndStartLive(channelId) {
    try {
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
      
      // Search for live streams (works for both public and unlisted)
      console.log(`[BOT] Searching for live streams on channel ${channelId}...`);
      const searchResponse = await youtube.search.list({
        auth: oauth2Client,
        part: 'id,snippet',
        channelId: channelId,
        eventType: 'live',
        type: 'video'
      });

      if (searchResponse.data.items && searchResponse.data.items.length > 0) {
        console.log(`[BOT] Found live stream for channel ${channelId}`);
        const videoId = searchResponse.data.items[0].id.videoId;
        
        // Get live chat ID
        const videoResponse = await youtube.videos.list({
          auth: oauth2Client,
          part: 'liveStreamingDetails,snippet',
          id: videoId
        });

        if (videoResponse.data.items && videoResponse.data.items.length > 0 && 
            videoResponse.data.items[0].liveStreamingDetails?.activeLiveChatId) {
          const liveBroadcast = {
            snippet: {
              liveChatId: videoResponse.data.items[0].liveStreamingDetails.activeLiveChatId
            }
          };
          
          if (!this.activeStreams.has(channelId)) {
            console.log(`[BOT] Found live stream with chat for channel: ${channelId}`);
            await this.startBot(channelId, liveBroadcast.snippet.liveChatId);
          }
        } else {
          console.log(`[BOT] Live stream found but no chat ID available for channel: ${channelId}`);
        }
      } else {
        console.log(`[BOT] No live stream found for channel: ${channelId}`);
        if (this.activeStreams.has(channelId)) {
          console.log(`[BOT] Stopping bot for channel: ${channelId}`);
          this.stopBot(channelId);
        }
      }
    } catch (err) {
      console.error(`[BOT] Error checking live for channel ${channelId}:`, err);
      if (err.message?.includes('quota')) {
        console.error('[BOT] YouTube API quota exceeded. Waiting for reset...');
      }
    }
  }

  async startBot(channelId, liveChatId) {
    try {
      console.log(`[BOT] Started for channel: ${channelId}, liveChatId: ${liveChatId}`);
      this.activeStreams.set(channelId, { liveChatId, nextPageToken: null });
      
      // Send initial message
      await this.sendMessage(channelId, 'I am ON!');
      console.log(`[BOT] Sent 'I am ON!' message to channel: ${channelId}`);

      // Start polling for messages every 3 seconds
      const pollInterval = setInterval(() => {
        this.pollChat(channelId);
      }, 3000);
      this.pollIntervals.set(channelId, pollInterval);

      // Start points distribution every 10 minutes, aligned to clock
      const now = new Date();
      const minutesToNext10 = 10 - (now.getMinutes() % 10);
      const msToNext10 = minutesToNext10 * 60 * 1000;

      // Initial delay to align with 10-minute intervals
      setTimeout(() => {
        this.distributePoints(channelId);
        // Then set up regular 10-minute interval
        setInterval(() => this.distributePoints(channelId), 10 * 60 * 1000);
      }, msToNext10);

    } catch (error) {
      console.error('[BOT] Error starting bot:', error);
    }
  }

  async pollChat(channelId) {
    const stream = this.activeStreams.get(channelId);
    if (!stream) return;

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
      
      // Use fields parameter to minimize quota usage
      const response = await youtube.liveChatMessages.list({
        auth: oauth2Client,
        liveChatId: stream.liveChatId,
        part: 'snippet,authorDetails',
        pageToken: stream.nextPageToken,
        fields: 'items(snippet(displayMessage),authorDetails(displayName,channelId)),nextPageToken'
      });

      stream.nextPageToken = response.data.nextPageToken;

      // Process messages
      for (const item of response.data.items) {
        await this.processMessage(channelId, item);
      }
    } catch (error) {
      console.error('[BOT] Error polling chat:', error);
      // Don't stop polling on error, just log it
    }
  }

  async processMessage(channelId, message) {
    try {
      if (!message || !message.snippet || !message.snippet.displayMessage) {
        return;
      }

      // Get bot info to check if message is from bot
      const bot = await Bot.findOne({});
      if (!bot || message.authorDetails.channelId === bot.botId) {
        // Skip processing bot's own messages
        return;
      }

      // Update last message timestamp
      this.lastMessageTimestamps.set(channelId, Date.now());
      
      const { snippet, authorDetails } = message;
      const text = snippet.displayMessage.toLowerCase();

      // Update viewer's last active time
      await Viewer.findOneAndUpdate(
        { channelId, viewerId: authorDetails.channelId },
        {
          channelId,
          viewerId: authorDetails.channelId,
          username: authorDetails.displayName,
          lastActive: new Date()
        },
        { upsert: true }
      );

      // Handle commands
      if (text.startsWith('!') || text.startsWith('/')) {
        const [command, ...args] = text.slice(1).split(' ');
        await this.handleCommand(channelId, authorDetails, command, args.join(' '));
      }

      console.log(`[BOT] Processed message from ${authorDetails.displayName} in channel ${channelId}: ${text}`);
    } catch (error) {
      console.error('[BOT] Error processing message:', error);
    }
  }

  async distributePoints(channelId) {
    try {
      const now = new Date();
      const tenMinutesAgo = new Date(now - 10 * 60 * 1000);

      // Get all viewers who sent at least one message in the last 10 minutes
      const activeViewers = await Viewer.find({
        channelId,
        lastActive: { $gte: tenMinutesAgo }
      });

      // Award points and update watch time
      for (const viewer of activeViewers) {
        await Viewer.findOneAndUpdate(
          { channelId, viewerId: viewer.viewerId },
          { 
            $inc: { 
              points: 10,
              watchMinutes: 10
            }
          }
        );
        console.log(`[BOT] Awarded 10 points and 10 minutes to ${viewer.username} in channel ${channelId}`);
      }
    } catch (error) {
      console.error('[BOT] Error distributing points:', error);
    }
  }

  async handleCommand(channelId, author, command, args) {
    try {
      switch (command.toLowerCase()) {
        case 'points':
          await this.handlePointsCommand(channelId, author);
          break;
        case 'hours':
          await this.handleHoursCommand(channelId, author);
          break;
        case 'top':
          await this.handleTopCommand(channelId);
          break;
        case 'tophours':
          await this.handleTopHoursCommand(channelId);
          break;
        case 'gamble':
          await this.handleGambleCommand(channelId, author, args);
          break;
        case 'ask':
          await this.handleAskCommand(channelId, author, args);
          break;
        default:
          // Unknown command
          break;
      }
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
        await this.sendMessage(channelId, `${author.displayName} has ${viewer.points} points and has watched for ${viewer.watchMinutes} minutes!`);
        console.log(`[BOT] Sent points message to ${author.displayName} in channel ${channelId}`);
      }
    } catch (error) {
      console.error('[BOT] Error handling points command:', error);
    }
  }

  async handleHoursCommand(channelId, author) {
    try {
      const viewer = await Viewer.findOne({
        channelId,
        viewerId: author.channelId
      });

      if (!viewer) {
        await this.sendMessage(channelId, `${author.displayName} , you haven't watched any streams yet!`);
        return;
      }

      const hours = Math.floor(viewer.watchMinutes / 60);
      const minutes = viewer.watchMinutes % 60;
      await this.sendMessage(channelId, `${author.displayName} , you have watched for ${hours} hours and ${minutes} minutes!`);
    } catch (error) {
      console.error('[BOT] Error handling hours command:', error);
    }
  }

  async handleTopCommand(channelId) {
    try {
      const topViewers = await Viewer.find({ channelId })
        .sort({ points: -1 })
        .limit(5);

      if (!topViewers.length) {
        await this.sendMessage(channelId, 'No viewers found!');
        return;
      }

      const leaderboard = topViewers
        .map((viewer, index) => `${index + 1}. ${viewer.username} (${viewer.points} points)`)
        .join(' | ');

      await this.sendMessage(channelId, `Top Points: ${leaderboard}`);
    } catch (error) {
      console.error('[BOT] Error handling top command:', error);
    }
  }

  async handleTopHoursCommand(channelId) {
    try {
      const topViewers = await Viewer.find({ channelId })
        .sort({ watchMinutes: -1 })
        .limit(5);

      if (!topViewers.length) {
        await this.sendMessage(channelId, 'No viewers found!');
        return;
      }

      const leaderboard = topViewers
        .map((viewer, index) => {
          const hours = Math.floor(viewer.watchMinutes / 60);
          const minutes = viewer.watchMinutes % 60;
          return `${index + 1}. ${viewer.username} (${hours}h ${minutes}m)`;
        })
        .join(' | ');

      await this.sendMessage(channelId, `Top Watch Time: ${leaderboard}`);
    } catch (error) {
      console.error('[BOT] Error handling top hours command:', error);
    }
  }

  async handleGambleCommand(channelId, author, amount) {
    try {
      let points;
      const viewer = await Viewer.findOne({
        channelId,
        viewerId: author.channelId
      });

      if (!viewer) {
        await this.sendMessage(channelId, `${author.displayName} , you don't have any points to gamble!`);
        return;
      }

      // Handle "all" command
      if (amount && amount.toLowerCase() === 'all') {
        points = viewer.points;
      } else {
        points = parseInt(amount);
      }

      if (isNaN(points) || points <= 0) {
        await this.sendMessage(channelId, `${author.displayName} , please specify a valid amount of points to gamble!`);
        return;
      }

      if (viewer.points < points) {
        await this.sendMessage(channelId, `${author.displayName} , you don't have enough points!`);
        return;
      }

      // Generate random number between 1-100
      const roll = Math.floor(Math.random() * 100) + 1;
      let multiplier = 0;
      let resultMessage = '';

      // Determine multiplier based on roll
      if (roll <= 40) {
        multiplier = -1; // Lose
        resultMessage = `Rolled ${roll}, ${author.displayName} , you lost ${points} points!`;
      } else if (roll <= 90) {
        multiplier = 2; // 2x
        resultMessage = `Rolled ${roll}, ${author.displayName} , you won ${points * (multiplier - 1)} points! (2x)`;
      } else if (roll <= 99) {
        multiplier = 3; // 3x
        resultMessage = `Rolled ${roll}, ${author.displayName} , you won ${points * (multiplier - 1)} points! (3x)`;
      } else {
        multiplier = 10; // 10x
        resultMessage = `Rolled ${roll}, ${author.displayName} , you won ${points * (multiplier - 1)} points! (10x JACKPOT!)`;
      }

      // Calculate point change (subtract original bet and add winnings)
      const pointsChange = points * (multiplier - 1);
      
      await Viewer.findOneAndUpdate(
        { channelId, viewerId: author.channelId },
        { $inc: { points: pointsChange } }
      );

      await this.sendMessage(channelId, resultMessage);
      console.log(`[BOT] Processed gamble for ${author.displayName} in channel ${channelId}: ${resultMessage}`);
    } catch (error) {
      console.error('[BOT] Error handling gamble command:', error);
    }
  }

  async handleAskCommand(channelId, author, question) {
    try {
      if (!question) {
        await this.sendMessage(channelId, `${author.displayName} , please provide a question!`);
        return;
      }

      // Get bot info to check if message is from bot
      const bot = await Bot.findOne({});
      if (!bot || author.channelId === bot.botId) {
        // Skip processing bot's own messages
        return;
      }

      // Use Gemini 2.0 Flash for faster, concise responses
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      
      // Add instruction for brief response
      const prompt = `Please provide a brief, clear answer (maximum 150 characters) to: ${question}`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Ensure response fits YouTube chat limits
      const maxLength = 150;
      const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
      
      console.log(`[BOT][DEBUG][GEMINI] Gemini response for /ask:`, truncatedText);
      await this.sendMessage(channelId, `${author.displayName} , ${truncatedText}`);
      console.log(`[BOT] Sent AI response to ${author.displayName} in channel ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error handling ask command:', error);
      await this.sendMessage(channelId, `${author.displayName} , sorry, I couldn't process your question.`);
    }
  }

  async sendMessage(channelId, text) {
    const stream = this.activeStreams.get(channelId);
    if (!stream) return;
    try {
      // Get the first (and only) bot instance since we only have one bot
      const bot = await Bot.findOne({});
      if (!bot) {
        console.error('[BOT] No bot credentials found');
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