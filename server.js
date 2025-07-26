const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT; // Nur den Render-Port verwenden

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).catch(err => console.error('MongoDB connection error:', err));

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 1000 },
});
const User = mongoose.model('User', userSchema);

// Message Schema
const messageSchema = new mongoose.Schema({
  username: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model('Message', messageSchema);

// Online Users
let onlineUsers = new Set();

// Authentication Middleware
const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id);
    if (!req.user) throw new Error();
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Routes
app.post('/api/register', async (req, res) => {
  console.log('Received register request:', req.body); // Debugging
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });
    await user.save();
    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ error: 'Username already taken' });
    } else {
      console.error('Registration error:', error);
      res.status(400).json({ error: 'Invalid data' });
    }
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, username, balance: user.balance });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/balance', authMiddleware, async (req, res) => {
  res.json({ balance: req.user.balance });
});

app.post('/api/blackjack', authMiddleware, async (req, res) => {
  const { bet } = req.body;
  if (bet <= 0 || bet > req.user.balance) {
    return res.status(400).json({ error: 'Invalid bet amount' });
  }
  const playerCards = [Math.floor(Math.random() * 13) + 1, Math.floor(Math.random() * 13) + 1];
  const dealerCards = [Math.floor(Math.random() * 13) + 1, Math.floor(Math.random() * 13) + 1];
  const playerScore = playerCards.reduce((a, b) => a + Math.min(b, 10), 0);
  const dealerScore = dealerCards.reduce((a, b) => a + Math.min(b, 10), 0);

  let result = 'lose';
  if (playerScore > 21) {
    req.user.balance -= bet;
  } else if (playerScore > dealerScore || dealerScore > 21) {
    req.user.balance += bet;
    result = 'win';
  } else if (playerScore === dealerScore) {
    result = 'tie';
  } else {
    req.user.balance -= bet;
  }
  await req.user.save();
  res.json({ result, balance: req.user.balance, playerCards, dealerCards });
});

app.post('/api/mines', authMiddleware, async (req, res) => {
  const { bet, tiles } = req.body;
  if (bet <= 0 || bet > req.user.balance) {
    return res.status(400).json({ error: 'Invalid bet amount' });
  }
  const mines = new Set();
  while (mines.size < 5) mines.add(Math.floor(Math.random() * 25));
  const hitMine = tiles.some(tile => mines.has(tile));
  if (hitMine) {
    req.user.balance -= bet;
  } else {
    req.user.balance += bet * 1.5; // Multiplikator für Gewinn
  }
  await req.user.save();
  res.json({ hitMine, balance: req.user.balance, mines: Array.from(mines) });
});

io.on('connection', socket => {
  socket.on('join', async ({ username, token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user || user.username !== username) throw new Error();
      socket.username = username;
      onlineUsers.add(username);
      io.emit('onlineUsers', Array.from(onlineUsers));

      const messages = await Message.find().sort({ timestamp: -1 }).limit(50);
      socket.emit('messages', messages.reverse());
    } catch (error) {
      socket.disconnect();
    }
  });

  socket.on('message', async message => {
    if (!socket.username) return;
    const msg = new Message({ username: socket.username, message });
    await msg.save();
    io.emit('message', msg);
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.username);
      io.emit('onlineUsers', Array.from(onlineUsers));
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));