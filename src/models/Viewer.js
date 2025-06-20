const mongoose = require('mongoose');

const viewerSchema = new mongoose.Schema({
  channelId: {
    type: String,
    required: true
  },
  viewerId: {
    type: String,
    required: true
  },
  username: {
    type: String,
    required: true
  },
  lastActive: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  welcomeMessage: {
    type: Boolean,
    default: false
  }
});

// Keep only this compound index
viewerSchema.index({ channelId: 1, viewerId: 1 }, { unique: true });

module.exports = mongoose.model('Viewer', viewerSchema); 