require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./auth/routes');
const botRoutes = require('./bot/routes');
const botService = require('./bot/service');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('[DB] Connected to MongoDB');
    // Initialize bot service after DB connection
    botService.initBot();

    app.listen(PORT, () => {
      console.log(`[SERVER] Server running on port ${PORT}`);
    });
  })
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/auth', authRoutes);
app.use('/bot', botRoutes);

// Root route - redirect to setup page
app.get('/', (req, res) => {
  res.redirect('/setup.html');
});

// Setup page route
app.get('/setup', (req, res) => {
  res.redirect('/setup.html');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;