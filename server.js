const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname)));

const playerHandler = require('./api/player/[...path]');
const operatorHandler = require('./api/operator/[...path]');
const publicConfigHandler = require('./api/public/config');

// Fijar req.url al originalUrl para que los handlers Vercel funcionen igual
app.all('/api/player*', (req, res) => {
  req.url = req.originalUrl;
  playerHandler(req, res);
});
app.all('/api/operator*', (req, res) => {
  req.url = req.originalUrl;
  operatorHandler(req, res);
});
app.all('/api/public/config', (req, res) => {
  req.url = req.originalUrl;
  publicConfigHandler(req, res);
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`player-portal corriendo en puerto ${PORT}`));
