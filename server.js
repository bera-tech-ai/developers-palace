const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/devsarena', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Enhanced MongoDB Schemas
const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  role: { type: String, required: true },
  level: { type: String, required: true },
  skills: [String],
  country: { type: String, default: 'Global' },
  timezone: String,
  bio: String,
  avatar: String,
  reputation: { type: Number, default: 0 },
  isVerified: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  badges: [{
    name: String,
    icon: String,
    color: String,
    earnedAt: { type: Date, default: Date.now }
  }],
  joinedAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const projectSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  githubUrl: String,
  liveUrl: String,
  tags: [String],
  image: String,
  files: [{
    name: String,
    content: String,
    language: String
  }],
  likes: { type: Number, default: 0 },
  collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isPublic: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: String,
  room: String,
  type: { type: String, default: 'text' }, // text, code, file
  codeSnippet: {
    language: String,
    code: String
  },
  file: {
    name: String,
    url: String
  },
  timestamp: { type: Date, default: Date.now }
});

const apiSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, required: true },
  endpoint: { type: String, required: true },
  method: { type: String, default: 'GET' },
  headers: Object,
  parameters: Object,
  body: Object,
  category: String,
  isFree: { type: Boolean, default: true },
  rateLimit: { type: Number, default: 100 },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isApproved: { type: Boolean, default: false },
  usageCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const lessonSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  category: { type: String, required: true },
  difficulty: { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'beginner' },
  codeExamples: [String],
  quiz: [{
    question: String,
    options: [String],
    correctAnswer: Number,
    explanation: String
  }],
  order: Number,
  duration: Number, // in minutes
  completedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const badgeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  icon: String,
  color: String,
  criteria: {
    type: String,
    reputation: Number,
    projects: Number,
    lessons: Number
  }
});

const hackathonSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  startDate: Date,
  endDate: Date,
  prizes: [String],
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  submissions: [{
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date, default: Date.now }
  }],
  winners: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive: { type: Boolean, default: true }
});

// MongoDB Models
const User = mongoose.model('User', userSchema);
const Project = mongoose.model('Project', projectSchema);
const Message = mongoose.model('Message', messageSchema);
const API = mongoose.model('API', apiSchema);
const Lesson = mongoose.model('Lesson', lessonSchema);
const Badge = mongoose.model('Badge', badgeSchema);
const Hackathon = mongoose.model('Hackathon', hackathonSchema);

// Socket.IO Connection Handling with rooms
const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('user_joined', async (userData) => {
    connectedUsers.set(socket.id, userData);
    
    // Update user's last active
    await User.findByIdAndUpdate(userData._id, { lastActive: new Date() });
    
    // Join general room by default
    socket.join('general');
    
    // Broadcast to all clients
    socket.broadcast.emit('user_joined', userData);
    
    // Send online users list
    updateOnlineUsers();
    
    // Send user badges
    const userWithBadges = await User.findById(userData._id).populate('badges');
    socket.emit('user_badges', userWithBadges.badges);
  });

  socket.on('join_room', (room) => {
    socket.leave(socket.currentRoom);
    socket.join(room);
    socket.currentRoom = room;
    console.log(`User joined room: ${room}`);
  });

  socket.on('chat_message', async (data) => {
    try {
      // Save message to database
      const message = new Message({
        user: data.userId,
        text: data.text,
        room: data.room,
        timestamp: data.timestamp
      });
      await message.save();

      // Populate user data before emitting
      const populatedMessage = await Message.findById(message._id).populate('user', 'fullName avatar isVerified');
      
      // Broadcast to all clients in the room
      io.to(data.room).emit('chat_message', {
        ...populatedMessage.toObject(),
        userId: data.userId
      });

      // AI Moderation for toxicity
      if (data.text.length > 10) {
        const moderation = await openai.moderations.create({
          input: data.text
        });
        
        if (moderation.results[0].flagged) {
          // Handle toxic content
          console.log('Toxic content detected:', data.text);
          // Could implement warning system here
        }
      }
    } catch (error) {
      console.error('Error saving message:', error);
    }
  });

  socket.on('disconnect', () => {
    const userData = connectedUsers.get(socket.id);
    if (userData) {
      socket.broadcast.emit('user_left', userData);
      connectedUsers.delete(socket.id);
      updateOnlineUsers();
    }
    console.log('User disconnected:', socket.id);
  });

  function updateOnlineUsers() {
    const onlineUsers = Array.from(connectedUsers.values());
    io.emit('online_users', onlineUsers);
  }
});

// Free APIs data (real APIs from the internet)
const freeAPIs = [
  {
    name: 'JSONPlaceholder',
    description: 'Fake Online REST API for Testing and Prototyping',
    endpoint: 'https://jsonplaceholder.typicode.com/posts',
    method: 'GET',
    category: 'Development'
  },
  {
    name: 'OpenWeatherMap',
    description: 'Weather Data and API for developers',
    endpoint: 'https://api.openweathermap.org/data/2.5/weather',
    method: 'GET',
    category: 'Weather'
  },
  {
    name: 'CoinGecko',
    description: 'Cryptocurrency Market Data',
    endpoint: 'https://api.coingecko.com/api/v3/coins/markets',
    method: 'GET',
    category: 'Cryptocurrency'
  },
  {
    name: 'NewsAPI',
    description: 'Search worldwide news with code',
    endpoint: 'https://newsapi.org/v2/top-headlines',
    method: 'GET',
    category: 'News'
  },
  {
    name: 'REST Countries',
    description: 'Get information about countries via a RESTful API',
    endpoint: 'https://restcountries.com/v3.1/all',
    method: 'GET',
    category: 'Geography'
  },
  {
    name: 'The Cat API',
    description: 'Pictures and facts about cats',
    endpoint: 'https://api.thecatapi.com/v1/images/search',
    method: 'GET',
    category: 'Animals'
  }
];

// API Routes

// User Authentication
app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullName, email, role, level, skills, bio } = req.body;
    
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const user = new User({
      fullName,
      email,
      role,
      level,
      skills,
      bio,
      badges: [{
        name: 'Newcomer',
        icon: 'fa-seedling',
        color: 'green'
      }]
    });

    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'fallback_secret');
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'fallback_secret');
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Projects
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await Project.find({ isPublic: true })
      .populate('owner', 'fullName avatar isVerified')
      .sort({ createdAt: -1 })
      .limit(12);
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const project = new Project(req.body);
    await project.save();
    
    // Award badge for first project
    const user = await User.findById(req.body.owner);
    if (user) {
      const hasProjectBadge = user.badges.some(badge => badge.name === 'First Project');
      if (!hasProjectBadge) {
        user.badges.push({
          name: 'First Project',
          icon: 'fa-rocket',
          color: 'blue'
        });
        await user.save();
      }
    }
    
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Assistant
app.post('/api/ai/ask', async (req, res) => {
  try {
    const { question, mode } = req.body;
    
    let prompt = '';
    switch (mode) {
      case 'explain':
        prompt = `Explain this code in detail:\n\n${question}\n\nProvide a clear explanation of what the code does, how it works, and any important concepts.`;
        break;
      case 'debug':
        prompt = `Debug this code and explain the issues:\n\n${question}\n\nIdentify bugs, suggest fixes, and explain why the original code doesn't work.`;
        break;
      case 'generate':
        prompt = `Generate code for: ${question}\n\nProvide clean, well-commented code that solves the problem.`;
        break;
      case 'learn':
        prompt = `Explain this programming concept: ${question}\n\nProvide a comprehensive explanation with examples.`;
        break;
      default:
        prompt = question;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are an expert programming assistant. Provide clear, concise, and helpful explanations. Always use code examples when relevant."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 1000
    });

    const answer = completion.choices[0].message.content;
    res.json({ answer });
  } catch (error) {
    console.error('OpenAI API error:', error);
    // Fallback response if OpenAI fails
    const fallbackAnswers = {
      explain: `Let me explain: ${question} - This code appears to be well-structured. Key components include...`,
      debug: `Debugging: ${question} - Check for common issues like syntax errors, variable scope, and async handling.`,
      generate: `Here's sample code:\n\nfunction solution() {\n  // Implementation here\n  return result;\n}`,
      learn: `Concept explanation: ${question} - This is fundamental to programming. Practice with small examples.`
    };
    res.json({ answer: fallbackAnswers[mode] || 'I understand your question. In a full implementation, I would provide a detailed response.' });
  }
});

// APIs Hub
app.get('/api/apis', async (req, res) => {
  try {
    // Combine free APIs with user-submitted approved APIs
    const userAPIs = await API.find({ isApproved: true });
    const allAPIs = [...freeAPIs, ...userAPIs];
    res.json(allAPIs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/apis', async (req, res) => {
  try {
    const api = new API(req.body);
    await api.save();
    res.json(api);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test API endpoint
app.get('/api/apis/:id/test', async (req, res) => {
  try {
    const api = await API.findById(req.params.id);
    if (!api) {
      return res.status(404).json({ error: 'API not found' });
    }

    // Increment usage count
    api.usageCount += 1;
    await api.save();

    // Here you would make the actual API call
    // For demo, return mock data
    res.json({
      message: 'API test successful',
      data: { id: 1, name: 'Test Item', value: 'Test Data' },
      api: api.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lessons
app.get('/api/lessons', async (req, res) => {
  try {
    const lessons = await Lesson.find().sort({ order: 1 }).limit(9);
    res.json(lessons);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const userCount = await User.countDocuments();
    const projectCount = await Project.countDocuments();
    const apiCount = await API.countDocuments({ isApproved: true }) + freeAPIs.length;
    const hackathonCount = await Hackathon.countDocuments({ isActive: true });
    
    res.json({
      onlineUsers: connectedUsers.size,
      totalUsers: userCount,
      totalProjects: projectCount,
      availableAPIs: apiCount,
      activeChallenges: hackathonCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Routes
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    // Basic admin authentication check
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    const user = await User.findById(decoded.userId);
    
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const stats = {
      totalUsers: await User.countDocuments(),
      totalProjects: await Project.countDocuments(),
      pendingApprovals: await API.countDocuments({ isApproved: false }),
      totalMessages: await Message.countDocuments(),
      recentUsers: await User.find().sort({ joinedAt: -1 }).limit(5),
      systemHealth: 'Operational'
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// File Upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
});
const upload = multer({ storage: storage });

app.post('/api/upload', upload.single('file'), (req, res) => {
  res.json({ 
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`
  });
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Admin route
app.get('/admin', (req, res) => {
  // In production, this would serve a separate admin page
  res.redirect('/');
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Devs Arena server running on port ${PORT}`);
  console.log(`Access the application at: http://localhost:${PORT}`);
});
