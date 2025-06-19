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
  points: {
    type: Number,
    default: 0
  },
  watchMinutes: {
    type: Number,
    default: 0
  },
  lastActive: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  isFree: {
    type: Boolean,
    default: false
  },
  welcomeMessage: {
    type: Boolean,
    default: false
  }
});

// Keep only this compound index
viewerSchema.index({ channelId: 1, viewerId: 1 }, { unique: true });

module.exports = mongoose.model('Viewer', viewerSchema); 