const { google } = require('googleapis');
const Project = require('../models/Project');
const { defaultProjects } = require('../config/projects');

class ProjectService {
  constructor() {
    this.currentProjectIndex = 0;
    this.projects = [];
  }

  // Initialize projects in database
  async initializeProjects() {
    try {
      const existingProjects = await Project.find({});
      
      if (existingProjects.length === 0) {
        console.log('[PROJECT] No projects found. Creating default projects...');
        
        for (const projectConfig of defaultProjects) {
          // Only create project if all required credentials are available
          if (projectConfig.googleClientId && projectConfig.googleClientSecret && 
              projectConfig.youtubeApiKey && projectConfig.geminiApiKey) {
            await Project.create(projectConfig);
            console.log(`[PROJECT] Created project: ${projectConfig.projectId}`);
          } else {
            console.log(`[PROJECT] Skipping ${projectConfig.projectId} - missing credentials`);
          }
        }
      }
      
      await this.loadProjects();
      const status = await this.getProjectStatus();
      
      // Log setup instructions to console
      this.logSetupInstructions(status);
      
      return status;
    } catch (error) {
      console.error('[PROJECT] Error initializing projects:', error);
      throw error;
    }
  }

  // Load projects from database
  async loadProjects() {
    try {
      this.projects = await Project.find({ isActive: true }).sort({ priority: 1 });
      console.log(`[PROJECT] Loaded ${this.projects.length} active projects`);
    } catch (error) {
      console.error('[PROJECT] Error loading projects:', error);
      throw error;
    }
  }

  // Get current project status
  async getProjectStatus() {
    await this.loadProjects();
    
    const configuredProjects = this.projects.filter(p => p.oauthTokens?.access_token);
    const totalProjects = this.projects.length;
    
    return {
      configured: configuredProjects.length,
      total: totalProjects,
      projects: this.projects.map(p => ({
        projectId: p.projectId,
        configured: !!p.oauthTokens?.access_token,
        quotaExceeded: p.quotaExceeded,
        priority: p.priority
      }))
    };
  }

  // Generate OAuth URLs for unconfigured projects
  generateOAuthUrls() {
    const urls = [];
    
    for (const project of this.projects) {
      if (!project.oauthTokens?.access_token) {
        const oauth2Client = new google.auth.OAuth2(
          project.googleClientId,
          project.googleClientSecret,
          process.env.GOOGLE_REDIRECT_URI
        );
        
        const authUrl = oauth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: [
            'https://www.googleapis.com/auth/youtube.force-ssl',
            'https://www.googleapis.com/auth/youtube.readonly'
          ],
          prompt: 'consent',
          state: project.projectId
        });
        
        urls.push({
          projectId: project.projectId,
          url: authUrl,
          priority: project.priority
        });
      }
    }
    
    return urls.sort((a, b) => a.priority - b.priority);
  }

  // Handle OAuth callback
  async handleOAuthCallback(projectId, code) {
    try {
      const project = await Project.findOne({ projectId });
      if (!project) {
        throw new Error(`Project ${projectId} not found`);
      }

      const oauth2Client = new google.auth.OAuth2(
        project.googleClientId,
        project.googleClientSecret,
        process.env.GOOGLE_REDIRECT_URI
      );

      const { tokens } = await oauth2Client.getToken(code);
      
      // Update project with OAuth tokens
      project.oauthTokens = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date
      };
      
      await project.save();
      await this.loadProjects();
      
      console.log(`[PROJECT] OAuth configured for ${projectId}`);
      return true;
    } catch (error) {
      console.error(`[PROJECT] Error handling OAuth callback for ${projectId}:`, error);
      throw error;
    }
  }

  // Get next available project (round-robin with quota check)
  async getNextAvailableProject() {
    await this.loadProjects();
    
    const availableProjects = this.projects.filter(p => 
      p.oauthTokens?.access_token && !p.quotaExceeded
    );
    
    if (availableProjects.length === 0) {
      // Check if any projects need quota reset (daily reset)
      const now = new Date();
      const projectsToReset = this.projects.filter(p => {
        if (!p.quotaExceededAt) return false;
        const resetTime = new Date(p.quotaExceededAt);
        return now.getDate() !== resetTime.getDate() || 
               now.getMonth() !== resetTime.getMonth() ||
               now.getFullYear() !== resetTime.getFullYear();
      });
      
      if (projectsToReset.length > 0) {
        console.log('[PROJECT] Resetting quota for projects:', projectsToReset.map(p => p.projectId));
        for (const project of projectsToReset) {
          project.quotaExceeded = false;
          project.quotaExceededAt = null;
          await project.save();
        }
        await this.loadProjects();
        return this.getNextAvailableProject();
      }
      
      throw new Error('No available projects with quota remaining');
    }
    
    // Round-robin selection
    this.currentProjectIndex = (this.currentProjectIndex + 1) % availableProjects.length;
    const selectedProject = availableProjects[this.currentProjectIndex];
    
    // Update last used timestamp
    selectedProject.lastUsed = new Date();
    await selectedProject.save();
    
    return selectedProject;
  }

  // Mark project as quota exceeded
  async markQuotaExceeded(projectId) {
    try {
      const project = await Project.findOne({ projectId });
      if (project) {
        project.quotaExceeded = true;
        project.quotaExceededAt = new Date();
        await project.save();
        console.log(`[PROJECT] Marked ${projectId} as quota exceeded`);
      }
    } catch (error) {
      console.error(`[PROJECT] Error marking quota exceeded for ${projectId}:`, error);
    }
  }

  // Refresh OAuth token if needed
  async refreshTokenIfNeeded(project) {
    try {
      if (!project.oauthTokens?.refresh_token) {
        throw new Error('No refresh token available');
      }

      const oauth2Client = new google.auth.OAuth2(
        project.googleClientId,
        project.googleClientSecret,
        process.env.GOOGLE_REDIRECT_URI
      );

      oauth2Client.setCredentials({
        access_token: project.oauthTokens.access_token,
        refresh_token: project.oauthTokens.refresh_token
      });

      const { credentials } = await oauth2Client.refreshAccessToken();
      
      // Update project with new tokens
      project.oauthTokens = {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token || project.oauthTokens.refresh_token,
        expiry_date: credentials.expiry_date
      };
      
      await project.save();
      console.log(`[PROJECT] Refreshed token for ${project.projectId}`);
      
      return project;
    } catch (error) {
      console.error(`[PROJECT] Error refreshing token for ${project.projectId}:`, error);
      throw error;
    }
  }

  // Get Gemini AI instance for current project
  async getGeminiAI() {
    const project = await this.getNextAvailableProject();
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    return new GoogleGenerativeAI(project.geminiApiKey);
  }

  // Get YouTube OAuth client for current project
  async getYouTubeOAuthClient() {
    const project = await this.getNextAvailableProject();
    
    // Check if token needs refresh
    if (project.oauthTokens.expiry_date && new Date() >= project.oauthTokens.expiry_date) {
      await this.refreshTokenIfNeeded(project);
    }
    
    const oauth2Client = new google.auth.OAuth2(
      project.googleClientId,
      project.googleClientSecret,
      process.env.GOOGLE_REDIRECT_URI
    );
    
    oauth2Client.setCredentials({
      access_token: project.oauthTokens.access_token,
      refresh_token: project.oauthTokens.refresh_token
    });
    
    return { oauth2Client, project };
  }

  // Log OAuth setup instructions to console
  logSetupInstructions(status) {
    console.log('\n' + '='.repeat(60));
    console.log('🔧 YOUTUBE LIVE CHAT BOT SETUP');
    console.log('='.repeat(60));
    console.log(`Status: ${status.configured}/${status.total} OAuth accounts configured`);
    
    if (status.configured === 0) {
      console.log('\n❌ No OAuth accounts configured. Please setup OAuth accounts:');
      const oauthUrls = this.generateOAuthUrls();
      oauthUrls.forEach((oauth, index) => {
        console.log(`\n${index + 1}. Setup OAuth for ${oauth.projectId}:`);
        console.log(`   URL: ${oauth.url}`);
      });
      console.log('\n📝 Instructions:');
      console.log('1. Copy each URL above');
      console.log('2. Open in browser and login with Google');
      console.log('3. Authorize the bot application');
      console.log('4. Copy the authorization code from the redirect URL');
      console.log('5. Use the /bot/oauth/callback endpoint to complete setup');
    } else if (status.configured < status.total) {
      console.log('\n⚠️  Partial setup complete. Continue with remaining accounts:');
      const oauthUrls = this.generateOAuthUrls();
      oauthUrls.forEach((oauth, index) => {
        console.log(`\n${index + 1}. Setup OAuth for ${oauth.projectId}:`);
        console.log(`   URL: ${oauth.url}`);
      });
    } else {
      console.log('\n✅ All OAuth accounts configured! Bot is ready to start.');
    }
    
    console.log('\n' + '='.repeat(60));
  }
}

module.exports = new ProjectService(); 