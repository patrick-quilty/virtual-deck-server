'use strict';

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;


const server = require('http').createServer(app);
const io = require("socket.io")(server, {
  handlePreflightRequest: (req, res) => {
    const headers = {
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Origin": 'https://test-deck.herokuapp.com',
      "Access-Control-Allow-Credentials": true
    };
    res.writeHead(200, headers);
    res.end();
  }
});


const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const Airtable = require('airtable');
const base = new Airtable({apiKey: AIRTABLE_API_KEY}).base(AIRTABLE_BASE_ID);



// Restful validation before joining webSocket

app.get('/', function (req, res) {
  res.send(JSON.stringify({ Hello: 'Why are you here?' })).status(200);
});

app.get('/games', function (req, res) {
  // Return all gameNumbers on the first page as an array of strings
  base('GameRoomTable')
    .select({view: 'Grid view'})
    .firstPage((err, records) => {
      const gameNumbers = records.map(record => record.get('gameNumber'));
      res.send(JSON.stringify({ games: gameNumbers }));
    })
});

app.get('/games/:gameNumber', function (req, res) {
  // Return the game data if the gameNumber exists
  base('GameRoomTable')
    .select({filterByFormula: 'gameNumber = ' + req.params.gameNumber})
    .firstPage((err, records) => {
      if (records !== null && records[0]) {
        res.send(JSON.stringify({ data: records[0].fields }));
      } else {
        res.send(JSON.stringify({ data: 'Game Number Not Found' }));
      }
    })
});

app.post('/newGame', function (req, res) {
  // Post a new game to the database
  base('GameRoomTable').create([
    {
      'fields': {
        'gameNumber': '' + req.body.gameNumber,
        'game': '' + req.body.game,
        'players': '' + req.body.players,
        'users': '[]',
        'gameData': '' + req.body.gameData,
        'chatLog': `["Game Number ${req.body.gameNumber}: ${req.body.game} - ` + 
          `${req.body.players} Players"]`
      }
    }
  ], function(err, records) {
    // Return the newly made record after finding it in the database
    base('GameRoomTable').find(records[0].getId(), function(err, record) {
      if (record) {
        res.send(JSON.stringify({ record: record.fields.gameNumber }));
      } else {
        res.send(JSON.stringify({ record: 'Failed To Create New Game' }));
      }
    });
  });
});

app.post('/newUser', function (req, res) {
  // Post a new user to the database
  
  // Find the game by gameNumber
  base('GameRoomTable')
    .select({filterByFormula: 'gameNumber = ' + req.body.gameNumber})
    .firstPage((err, record) => { 
      const gameId = record[0].getId();

      // Format the updated userList object
      const commaIfNeeded = record[0].fields.users.length === 2 ? '' : ',';
      let newUserObject = JSON.parse(req.body.newUserObject);
      newUserObject.name = req.body.userName
      const userList = record[0].fields.users.slice(0, -1) +
          commaIfNeeded + JSON.stringify(newUserObject) + ']';

      // Post the userList to the database
      base('GameRoomTable')
        .update([{
          'id': gameId,
          'fields': { 'users': userList }
        }], function(err, records) {
          // Return mission success
            res.sendStatus(200);
        });
    })
});



// WebSocket

io.on('connection', (socket) => {
  // Constants for the socket to be defined upon connection
  let userName = '';
  let gameNumber = '';
  let dbGameId = '';
  let newUserObject = '';

  // First connection setup
  socket.on('first-contact', async (initialData) => {
    // Define socket variables
    userName = initialData.userName;
    gameNumber = initialData.gameNumber;
    newUserObject = initialData.newUserObject;

    // Join the socket for the right game
    socket.join(gameNumber);

    // Get the state of the gameRoom at the time of the connection
    const data = await getGameRoomData(gameNumber);
    dbGameId = data.id;
    const gameRoomData = data.fields;

    // Send the state to the client that just connected
    socket.emit('gameRoomState', gameRoomData);

    // Send connect message to the database and the gameRoom
    const message = getCurrentTime() + ' ' + userName + ' entered the room';
    postToChatLog(dbGameId, message);
    io.in(gameNumber).emit('updateRoom', {chatLog: message});
    io.in(gameNumber).emit('keepAlive', '');
    setInterval(function(){ // Send Pong
      socket.emit('stayAlive', '');
    }, 10000);
  });
  socket.on('keepAlive', () => {}); // Receive Ping

  // Send message to database and clients
  socket.on('chatLogMessage', (newMessage) => {
    const message = getCurrentTime() + ' ' + userName + ': ' + newMessage;
    postToChatLog(dbGameId, message);
    io.in(gameNumber).emit('updateRoom', {chatLog: message});
  });

  // Send game event message to database and clients
  socket.on('gameEventMessage', (newMessage) => {
    const message = getCurrentTime() + ' ' + newMessage;
    postToChatLog(dbGameId, message);
    io.in(gameNumber).emit('updateRoom', {chatLog: message});
  });

  // Update user
  socket.on('updateUser', async (userInfo) => {
    const newUsers = await updateUserList(dbGameId, userInfo);
    const gameData = await getGameData(dbGameId);
    io.in(gameNumber).emit('updateRoom', {users: newUsers, gameData: gameData});
  });

  // Update all seated users' inGame status
  socket.on('setInGame', async (status) => {
    const newUsers = await setInGame(dbGameId, status);
    io.in(gameNumber).emit('updateRoom', {users: newUsers});
  });

  // Update gameData
  socket.on('updateGameData', async (gameData) => {
    const newGameData = await updateGameData(dbGameId, gameData);
    io.in(gameNumber).emit('updateRoom', {gameData: newGameData});
  });

  //
  // Hold onto this for now until decided about sorting cards
  //
  // Update user and gameData
  // socket.on('updateUserAndGameData', async (data) => {
  //   const newUsers = await updateUserList(dbGameId, data.user);
  //   const newGameData = await updateGameData(dbGameId, data.gameData);
  //   io.in(gameNumber).emit('updateRoom', {users: newUsers, gameData: newGameData});
  // });

  // Disconnect processes
  socket.on('disconnect', async (reason) => {
    // Update user list and send leave message to database and gameRoom
    const message = getCurrentTime() + ' ' + userName + ' left the room';
    postToChatLog(dbGameId, message);
    const newUsers = await removeUserFromList(dbGameId, userName);
    io.in(gameNumber).emit('updateRoom', {chatLog: message, users: newUsers});
  });
});

async function getGameRoomData(gameNumber) {
  let records = await (
    base('GameRoomTable')
      .select({filterByFormula: 'gameNumber = ' + gameNumber})
      .firstPage()
  );
  return records[0];
}

function getCurrentTime() {
  const today = new Date();
  const timeZone = -4;
  const correction = today.getHours() + 12 + timeZone;
  const hours = (correction) % 12 === 0 ? 12 : (correction) % 12;
  const minutes = today.getMinutes() < 10 ? '0' + today.getMinutes() : today.getMinutes();
  const AMPM = (today.getHours() >= 0 - timeZone && today.getHours() < 12 - timeZone) ? 'am' : 'pm';
  const time = hours + ":" + minutes + AMPM;
  return time;
}

async function postToChatLog(dbGameId, message) {
  // Post new chatLog message to database

  // Find the record in the database
  const record = await base('GameRoomTable').find(dbGameId);

  // Format new chatLog
  const commaIfNeeded = record.fields.chatLog.length === 2 ? '' : ', ';
  const chatLog = record.fields.chatLog.slice(0, -1) + commaIfNeeded + JSON.stringify(message) + ']';

  // Post the chatLog to the database
  base('GameRoomTable')
    .update([{
      'id': dbGameId,
      'fields': { 'chatLog': chatLog }
    }]);
}

async function updateUserList(dbGameId, userInfo) {
  // Change user data in database

  // Get all users
  const record = await base('GameRoomTable').find(dbGameId);
  const users = JSON.parse(record.fields.users);

  // Format new users list
  let newUsers = users.filter(user => user.name !== userInfo.name);
  newUsers.push(userInfo);

  // Post the users list to the database
  base('GameRoomTable')
    .update([{
      'id': dbGameId,
      'fields': { 'users': JSON.stringify(newUsers) }
    }]);

  return (JSON.stringify(newUsers));
}

async function removeUserFromList(dbGameId, userName) {
  // On disconecting from the socket remove the user from the userlist on the database

  // Get all users
  const record = await base('GameRoomTable').find(dbGameId);
  const users = JSON.parse(record.fields.users);

  // Format new users list
  let newUsers = users.filter(user => user.name !== userName);

  // Post the users list to the database
  base('GameRoomTable')
    .update([{
      'id': dbGameId,
      'fields': { 'users': JSON.stringify(newUsers) }
    }]);

  return (JSON.stringify(newUsers));
}

async function setInGame(dbGameId, status) {
  // Update all sitting users' inGame status

  // Get all users
  const record = await base('GameRoomTable').find(dbGameId);
  const users = JSON.parse(record.fields.users);

  // Create array of sitting users and modify
  let sitting = users.filter(user => user.seat  !== 'chatRoom');
  sitting = sitting.map(user => {user.inGame = status;  return user;});

  // Create array of non-sitting users
  let newUsers = users.filter(user => user.seat === 'chatRoom');

  // Merge them
  sitting.forEach(user => newUsers.push(user));

  // Post the users list to the database
  base('GameRoomTable')
    .update([{
      'id': dbGameId,
      'fields': { 'users': JSON.stringify(newUsers) }
    }]);

  return (JSON.stringify(newUsers));
}

async function getGameData(dbGameId) {
  const record = await base('GameRoomTable').find(dbGameId);
  const gameData = JSON.parse(record.fields.gameData);
  return (JSON.stringify(gameData));
}

async function updateGameData(dbGameId, gameData) {
  // Update the database gameData

  // Get current gameData
  const record = await base('GameRoomTable').find(dbGameId);
  let newGameData = JSON.parse(record.fields.gameData);

  // Set the new gameData
  let newKeys = Object.keys(gameData);
  newKeys.forEach(key => {
    if (['cards', 'bids', 'round'].includes(key)) {
      newGameData[key] = Object.assign(newGameData[key], gameData[key]);
    } else {
      newGameData[key] = gameData[key]
    }
  });

  // Post the gameData to the database
  base('GameRoomTable')
    .update([{
      'id': dbGameId,
      'fields': { 'gameData': JSON.stringify(newGameData) }
    }]);

  return (JSON.stringify(newGameData));
}

server.listen(PORT, function () {
 console.log('Server listening on port:', PORT);
});
