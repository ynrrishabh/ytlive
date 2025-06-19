const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const User = require('../models/User');
const Viewer = require('../models/Viewer');
const cron = require('node-cron');
const Channel = require('../models/Channel');
const projectService = require('../services/projectService');

class BotService {
  constructor() {
    this.activeStreams = new Map(); // channelId -> { liveChatId, nextPageToken }
    this.autoMessageTimers = new Map(); // channelId -> timer
    this.liveCheckTasks = new Map(); // channelId -> cron task
    this.lastMessageTimestamps = new Map(); // channelId -> timestamp
    this.pollIntervals = new Map(); // channelId -> pollInterval
    this.gambleCooldowns = new Map(); // channelId:userId -> timestamp
    this.askCooldowns = new Map(); // channelId:userId -> timestamp for /ask cooldown
    this.isInitialized = false;
    this.paused = false; // Add paused flag
    this.recentMessages = new Map(); // channelId:userId -> [lastMessages]
    this.timeoutUsers = new Map(); // channelId:userId -> timeout expiry timestamp
    this.modCache = new Map(); // channelId -> { mods: Set, lastFetched: timestamp }
    this.welcomeMessages = [
      "Hey {name} , welcome to the stream baby! 💖",
      "So glad you joined us babe, {name} ! Enjoy the vibes! 🥰",
      "Welcome, {name} ! Sending you lots of love sweetie! ❤️"
      
    ];
    this.initBot();
  }

  async initBot() {
    if (this.paused) return; // Prevent init if paused
    try {
      // Initialize projects first
      const projectStatus = await projectService.initializeProjects();
      console.log(`[BOT] Project status: ${projectStatus.configured}/${projectStatus.total} configured`);
      if (projectStatus.configured === 0) {
        console.log('[BOT] No OAuth accounts configured. Please setup OAuth accounts first.');
        return;
      }
      if (projectStatus.configured < projectStatus.total) {
        console.log(`[BOT] ${projectStatus.configured}/${projectStatus.total} OAuth accounts configured. Waiting for all accounts to be configured before starting.`);
        return;
      }
      // Only initialize live detection, do not start monitoring channels automatically
      this.initLiveDetection();
      this.isInitialized = true;
    } catch (error) {
      console.error('[BOT] Error initializing bot:', error);
    }
  }

  // Get bot status
  getBotStatus() {
    return {
      isInitialized: this.isInitialized,
      activeStreams: this.activeStreams.size,
      channels: Array.from(this.activeStreams.keys())
    };
  }

  // Periodically check for live streams for all users
  initLiveDetection() {
    console.log('[BOT] Live detection initialized. Use manual check button to search for live streams.');
  }

  async checkLiveStatus() {
    try {
      const channels = await Channel.find({});
      console.log(`[BOT] Checking ${channels.length} channels for live streams...`);
      
      for (const channel of channels) {
        // Skip check if channel is already being monitored
        if (this.activeStreams.has(channel.channelId)) {
          continue;
        }
        await this.checkAndStartLive(channel.channelId);
      }
      return { success: true, message: 'Live check completed.' };
    } catch (err) {
      console.error('[BOT] Error in live detection:', err);
      return { success: false, message: 'Error checking for live streams: ' + err.message };
    }
  }

  async checkAndStartLive(channelId) {
    try {
      // Try all projects for initial search.list
      const { oauth2Client, project } = await projectService.getFirstWorkingProjectForSearch(channelId);
      const youtube = google.youtube('v3');
      // Search for live streams (works for both public and unlisted)
      console.log(`[BOT] Searching for live streams on channel ${channelId} using ${project.projectId}...`);
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
        // Get live chat ID (use same project for videos.list)
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
            // Try all projects for this live
            try {
              const { oauth2Client: workingClient, project: workingProject } = await projectService.getFirstWorkingProjectForLive(liveBroadcast.snippet.liveChatId);
              // Pass workingClient and workingProject to startBot if needed
              await this.startBot(channelId, liveBroadcast.snippet.liveChatId);
            } catch (err) {
              console.error(`[BOT] No available projects with quota for this live on channel ${channelId}`);
            }
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
        console.error('[BOT] YouTube API quota exceeded. Switching to next project...');
        const { project } = await projectService.getYouTubeOAuthClient();
        await projectService.markQuotaExceeded(project.projectId);
        setTimeout(() => this.checkAndStartLive(channelId), 1000);
      }
      if (err.response && err.response.status === 403) {
        console.error('[BOT] Received 403 Forbidden from YouTube API. Stopping bot for this channel.');
        this.stopBot(channelId);
        return;
      }
    }
  }

  async startBot(channelId, liveChatId) {
    try {
      console.log(`[BOT] Started for channel: ${channelId}, liveChatId: ${liveChatId}`);
      
      // Reset welcomeMessage and isAdmin for all viewers in this channel for the new live
      await this.resetWelcomeMessages(channelId);
      await this.resetIsAdmin(channelId);
      
      // Fetch and cache mod list once per live
      try {
        const { oauth2Client } = await projectService.getYouTubeOAuthClient();
        const youtube = google.youtube('v3');
        const mods = new Set();
        let nextPageToken = undefined;
        do {
          const resp = await youtube.liveChatModerators.list({
            auth: oauth2Client,
            liveChatId: liveChatId,
            part: 'snippet',
            maxResults: 50,
            pageToken: nextPageToken
          });
          if (resp.data.items) {
            for (const item of resp.data.items) {
              mods.add(item.snippet.moderatorDetails.channelId);
            }
          }
          nextPageToken = resp.data.nextPageToken;
        } while (nextPageToken);
        this.modCache.set(channelId, { mods });
      } catch (err) {
        this.modCache.set(channelId, { mods: new Set() });
      }
      
      // Initialize with null nextPageToken - this will make the first poll get only the most recent messages
      this.activeStreams.set(channelId, { 
        liveChatId,
        nextPageToken: null,
        firstPoll: true  // Flag to handle first poll specially
      });
      
      // Send initial message
      await this.sendMessage(channelId, 'I am ON! command list: /points ,/hours ,/top ,/tophours ,/gamble ,/ask');
      console.log(`[BOT] Sent 'I am ON!' message to channel: ${channelId}`);

      // Start polling for messages every 4 seconds
      const pollInterval = setInterval(() => {
        this.pollChat(channelId);
      }, 4000);
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

  async resetWelcomeMessages(channelId) {
    try {
      await Viewer.updateMany({ channelId }, { $set: { welcomeMessage: false } });
      console.log(`[BOT] Reset welcome messages for channel: ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error resetting welcome messages:', error);
    }
  }

  async resetIsAdmin(channelId) {
    try {
      await Viewer.updateMany({ channelId }, { $unset: { isAdmin: "" } });
      console.log(`[BOT] Reset isAdmin for channel: ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error resetting isAdmin:', error);
    }
  }

  async pollChat(channelId) {
    const stream = this.activeStreams.get(channelId);
    if (!stream) return;

    try {
      const { oauth2Client, project } = await projectService.getYouTubeOAuthClient();
      const youtube = google.youtube('v3');
      
      // If this is the first poll, only get the pageToken and do NOT process or print any messages
      if (stream.firstPoll) {
        const response = await youtube.liveChatMessages.list({
          auth: oauth2Client,
          liveChatId: stream.liveChatId,
          part: 'id', // Only need id to get nextPageToken
          maxResults: 1,
          fields: 'nextPageToken'
        });
        stream.nextPageToken = response.data.nextPageToken;
        stream.firstPoll = false;
        this.activeStreams.set(channelId, stream);
        // Do not print or process any messages on first poll
        return;
      }
      
      // Normal poll for subsequent requests
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
        await this.processMessage(channelId, item, project);
      }
    } catch (error) {
      console.error('[BOT] Error polling chat:', error);
      if (error.message?.includes('quota')) {
        console.error('[BOT] YouTube API quota exceeded during chat polling. Switching to next project...');
        const { project } = await projectService.getYouTubeOAuthClient();
        await projectService.markQuotaExceeded(project.projectId);
      }
      if (error.response && error.response.status === 403) {
        console.error('[BOT] Received 403 Forbidden from YouTube API during chat polling. Stopping bot for this channel.');
        this.stopBot(channelId);
        return;
      }
      // Don't stop polling on error, just log it
    }
  }

  async processMessage(channelId, message, project) {
    try {
      if (!message || !message.snippet || !message.snippet.displayMessage) {
        return;
      }
      const { snippet, authorDetails } = message;
      const text = snippet.displayMessage;
      const userKey = `${channelId}:${authorDetails.channelId}`;
      const now = Date.now();

      // Get bot's own channelId for this project
      let botChannelId = null;
      if (project) {
        botChannelId = await this.getBotChannelId(project);
      }
      // If the message is from the bot itself, skip welcome and moderation
      if (botChannelId && authorDetails.channelId === botChannelId) {
        // Optionally, still update last active and allow commands if needed
        this.lastMessageTimestamps.set(channelId, Date.now());
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
        // Optionally, handle commands from the bot itself (or skip)
        return;
      }

      // Fetch viewer and check isFree
      let viewer = await Viewer.findOne({ channelId, viewerId: authorDetails.channelId });
      if (!viewer) {
        // Create viewer if not exists
        viewer = await Viewer.create({
          channelId,
          viewerId: authorDetails.channelId,
          username: authorDetails.displayName,
          lastActive: new Date(),
          welcomeMessage: false
        });
      }
      // If user is marked isFree, skip all moderation and return immediately
      if (viewer.isFree === true) {
        // Optionally update last active and viewer info
        this.lastMessageTimestamps.set(channelId, Date.now());
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
        // Optionally, handle commands from isFree users
        if (text.toLowerCase().startsWith('/')) {
          const [command, ...args] = text.slice(1).split(' ');
          await this.handleCommand(channelId, authorDetails, command, args.join(' '));
        }
        return;
      }
      // Welcome message logic (for all non-isFree users)
      if (!viewer.welcomeMessage) {
        const name = authorDetails.displayName || 'friend';
        const msg = this.welcomeMessages[Math.floor(Math.random() * this.welcomeMessages.length)].replace('{name}', name);
        await this.sendMessage(channelId, msg);
        await Viewer.findOneAndUpdate(
          { channelId, viewerId: authorDetails.channelId },
          { welcomeMessage: true },
          { upsert: true }
        );
      }
      // Timeout check
      if (this.timeoutUsers.has(userKey)) {
        const expiry = this.timeoutUsers.get(userKey);
        if (now < expiry) {
          // User is timed out, ignore their messages
          return;
        } else {
          this.timeoutUsers.delete(userKey);
        }
      }
      // 3. Spam detection (same message) and link detection
      // Check moderationEnabled for this channel
      const channel = await Channel.findOne({ channelId });
      const moderationEnabled = channel?.moderationEnabled;
      if (moderationEnabled) {
        let recent = this.recentMessages.get(userKey) || [];
        recent.push(text);
        if (recent.length > 5) recent = recent.slice(-5);
        this.recentMessages.set(userKey, recent);
        // If user posted same message 2+ times in last 5 (i.e., repeated identical message)
        const repeatCount = recent.filter(m => m === text).length;
        if (repeatCount >= 2) {
          const liveChatId = this.activeStreams.get(channelId)?.liveChatId;
          console.debug('[BOT][MODERATION] Attempting to delete message:', {
            messageId: message.id,
            liveChatId,
            userChannelId: authorDetails.channelId
          });
          if (message.id) {
            await this.deleteMessage(message.id, channelId, project);
          } else {
            console.warn('[BOT][MODERATION] Cannot delete message: message.id is missing', message);
          }
          this.timeoutUsers.set(userKey, now + 60 * 1000); // 1 min
          if (liveChatId && authorDetails.channelId) {
            await this.timeoutUser(channelId, authorDetails.channelId, project, liveChatId);
          } else {
            console.warn('[BOT][MODERATION] Cannot timeout user: liveChatId or userChannelId is missing', { liveChatId, userChannelId: authorDetails.channelId });
          }
          await this.sendMessage(channelId, `@${authorDetails.displayName} spamming is not allowed! You are timed out for 1 min 😡`);
          return;
        }
        // Link detection
        if (/https?:\/\//i.test(text)) {
          const liveChatId = this.activeStreams.get(channelId)?.liveChatId;
          console.debug('[BOT][MODERATION] Attempting to delete message (link):', {
            messageId: message.id,
            liveChatId,
            userChannelId: authorDetails.channelId
          });
          if (message.id) {
            await this.deleteMessage(message.id, channelId, project);
          } else {
            console.warn('[BOT][MODERATION] Cannot delete message (link): message.id is missing', message);
          }
          this.timeoutUsers.set(userKey, now + 60 * 1000); // 1 min
          if (liveChatId && authorDetails.channelId) {
            await this.timeoutUser(channelId, authorDetails.channelId, project, liveChatId);
          } else {
            console.warn('[BOT][MODERATION] Cannot timeout user (link): liveChatId or userChannelId is missing', { liveChatId, userChannelId: authorDetails.channelId });
          }
          await this.sendMessage(channelId, `@${authorDetails.displayName} posting links is not allowed! You are timed out for 1 min 😡`);
          return;
        }
      }
      // Update last message timestamp
      this.lastMessageTimestamps.set(channelId, Date.now());
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
      if (text.toLowerCase().startsWith('/')) {
        const [command, ...args] = text.slice(1).split(' ');
        await this.handleCommand(channelId, authorDetails, command, args.join(' '));
      }
      console.log(`[BOT] Processed message from ${authorDetails.displayName} in channel ${channelId}: ${text}`);
    } catch (error) {
      console.error('[BOT] Error processing message:', error);
    }
  }

  // Get bot's channel ID for message filtering
  async getBotChannelId(project) {
    try {
      const oauth2Client = new google.auth.OAuth2(
        project.googleClientId,
        project.googleClientSecret,
        process.env.GOOGLE_REDIRECT_URI
      );
      
      oauth2Client.setCredentials({
        access_token: project.oauthTokens.access_token,
        refresh_token: project.oauthTokens.refresh_token
      });

      const youtube = google.youtube('v3');
      const response = await youtube.channels.list({
        auth: oauth2Client,
        part: 'id',
        mine: true
      });

      if (response.data.items && response.data.items.length > 0) {
        return response.data.items[0].id;
      }
      return null;
    } catch (error) {
      console.error('[BOT] Error getting bot channel ID:', error);
      return null;
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
        await this.sendMessage(channelId, `${author.displayName} has ${viewer.points} points!`);
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

      const hours = (viewer.watchMinutes / 60).toFixed(2);
      await this.sendMessage(channelId, `${author.displayName} , you have watched for ${hours} hours!`);
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
      // Cooldown check
      const cooldownKey = `${channelId}:${author.channelId}`;
      const now = Date.now();
      const lastGamble = this.gambleCooldowns.get(cooldownKey);
      if (lastGamble && now - lastGamble < 5 * 60 * 1000) {
        // On cooldown, do not reply
        return;
      }
      // Set cooldown
      this.gambleCooldowns.set(cooldownKey, now);

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
        points = Math.min(viewer.points, 3000); // Cap at 3000
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
      let emoji = '';
      if (roll <= 40) {
        multiplier = -1; // Lose
        emoji = '😢';
      } else if (roll <= 90) {
        multiplier = 2; // 2x
        emoji = '🎉';
      } else if (roll <= 99) {
        multiplier = 3; // 3x
        emoji = '🔥';
      } else {
        multiplier = 10; // 10x
        emoji = '💎🥳';
      }

      // Calculate point change (subtract original bet and add winnings)
      let pointsChange = points * (multiplier - 1);
      let newPoints = viewer.points + pointsChange;
      if (newPoints < 0) {
        pointsChange = -viewer.points; // Set to zero, can't go negative
        newPoints = 0;
      }
      await Viewer.findOneAndUpdate(
        { channelId, viewerId: author.channelId },
        { $inc: { points: pointsChange } }
      );

      // Build result message with new balance and emoji
      if (multiplier === -1) {
        resultMessage = `Rolled ${roll}, ${author.displayName} , you lost ${points} points! ${emoji} >>> (Balance: ${newPoints})`;
      } else if (multiplier === 2) {
        resultMessage = `Rolled ${roll}, ${author.displayName} , you won ${points * (multiplier - 1)} points! (2x) ${emoji} >>> (Balance: ${newPoints})`;
      } else if (multiplier === 3) {
        resultMessage = `Rolled ${roll}, ${author.displayName} , you won ${points * (multiplier - 1)} points! (3x) ${emoji} >>> (Balance: ${newPoints})`;
      } else if (multiplier === 10) {
        resultMessage = `Rolled ${roll}, ${author.displayName} , you won ${points * (multiplier - 1)} points! (10x JACKPOT!) ${emoji} >>> (Balance: ${newPoints})`;
      }

      await this.sendMessage(channelId, resultMessage);
      console.log(`[BOT] Processed gamble for ${author.displayName} in channel ${channelId}: ${resultMessage}`);
    } catch (error) {
      console.error('[BOT] Error handling gamble command:', error);
    }
  }

  async handleAskCommand(channelId, author, question) {
    try {
      // Cooldown check for /ask
      const cooldownKey = `${channelId}:${author.channelId}`;
      const now = Date.now();
      const lastAsk = this.askCooldowns.get(cooldownKey);
      if (lastAsk && now - lastAsk < 60 * 1000) {
        // On cooldown, do not reply
        console.log(`[BOT] Ignored /ask from ${author.displayName} in channel ${channelId} due to 1 min cooldown.`);
        return;
      }
      // Set cooldown
      this.askCooldowns.set(cooldownKey, now);

      if (!question) {
        await this.sendMessage(channelId, `${author.displayName} , please provide a question!`);
        return;
      }

      // Custom response for bot identity/creator questions
      const q = question.trim().toLowerCase();
      if (
        q === 'who are you' ||
        q === 'who made you' ||
        q === 'who is your creator' ||
        q.includes('your creator') ||
        q.includes('who created you') ||
        q.includes('who built you')
      ) {
        await this.sendMessage(channelId, `${author.displayName} , I am Mitshuri, made by Rishabh with his love ❤️🤖`);
        return;
      }

      // Get current project to check if message is from bot
      const { project } = await projectService.getYouTubeOAuthClient();
      const botChannelId = project.oauthTokens?.access_token ? 
        await this.getBotChannelId(project) : null;
      
      if (botChannelId && author.channelId === botChannelId) {
        // Skip processing bot's own messages
        return;
      }

      // Use Gemini AI from current project
      const genAI = await projectService.getGeminiAI();
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      
      // Add instruction for very brief response (max 180 chars)
      const prompt = `Please answer the following question in the shortest, most concise way possible, using no more than 180 characters. Do not add extra words or explanations.\nQuestion: ${question}`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      let text = response.text();
      
      // Ensure response fits YouTube chat limits (max 180 for answer)
      if (text.length > 180) text = text.substring(0, 180);
      
      console.log(`[BOT][DEBUG][GEMINI] Gemini response for /ask:`, text);
      await this.sendMessage(channelId, `${author.displayName} , ${text}`);
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
      const { oauth2Client, project } = await projectService.getYouTubeOAuthClient();
      const youtube = google.youtube('v3');
      
      console.log(`[BOT][DEBUG] Sending message to liveChatId for channel ${channelId} using ${project.projectId}: ${stream.liveChatId}`);
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
      console.log(`[BOT] Sent message: "${text}" to channel: ${channelId} using ${project.projectId}`);
    } catch (error) {
      console.error('[BOT] Error sending message:', error);
      if (error.message?.includes('quota')) {
        console.error('[BOT] YouTube API quota exceeded while sending message. Switching to next project...');
        const { project } = await projectService.getYouTubeOAuthClient();
        await projectService.markQuotaExceeded(project.projectId);
        // Retry with next project
        setTimeout(() => this.sendMessage(channelId, text), 1000);
      }
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
    if (this.pollIntervals.has(channelId)) {
      clearInterval(this.pollIntervals.get(channelId));
      this.pollIntervals.delete(channelId);
    }
    this.modCache.delete(channelId); // Clear mod cache for this channel
    console.log(`[BOT] Stopped for channel: ${channelId}`);
  }

  pauseBot() {
    this.paused = true;
    // Stop all polling and timers
    for (const [channelId] of this.activeStreams) {
      this.stopBot(channelId);
    }
    console.log('[BOT] Bot is now paused. Waiting for user to resume from web UI.');
  }

  resumeBot() {
    if (!this.paused) return;
    this.paused = false;
    this.initBot();
    console.log('[BOT] Bot resumed by user.');
  }

  // Helper to delete a message
  async deleteMessage(messageId, channelId, project) {
    try {
      const { oauth2Client } = await projectService.getYouTubeOAuthClient();
      const youtube = google.youtube('v3');
      await youtube.liveChatMessages.delete({ auth: oauth2Client, id: messageId });
      console.log(`[BOT] Deleted spam/link message in channel ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error deleting message:', error);
    }
  }

  // Helper to timeout a user
  async timeoutUser(channelId, userChannelId, project, liveChatId) {
    try {
      if (!liveChatId) {
        console.error('[BOT] Cannot timeout user: liveChatId is missing');
        return;
      }
      const { oauth2Client } = await projectService.getYouTubeOAuthClient();
      const youtube = google.youtube('v3');
      await youtube.liveChatBans.insert({
        auth: oauth2Client,
        part: 'snippet',
        requestBody: {
          snippet: {
            liveChatId: liveChatId,
            bannedUserDetails: { channelId: userChannelId },
            type: 'temporary',
            banDurationSeconds: 60
          }
        }
      });
      console.log(`[BOT] Timed out user ${userChannelId} in channel ${channelId}`);
    } catch (error) {
      console.error('[BOT] Error timing out user:', error);
    }
  }
}

module.exports = new BotService(); 