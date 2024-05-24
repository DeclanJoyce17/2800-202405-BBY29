"use strict";
// Load environment variables from .env file
require('dotenv').config();
const fs = require("fs");
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { ObjectId, MongoClient, GridFSBucket } = require('mongodb');
const path = require('path');
const bcrypt = require('bcrypt');
const saltRounds = 12;
const multer = require('multer');
const { SpeechClient } = require('@google-cloud/speech');
const { spawn } = require('child_process');
const sharp = require('sharp');
const axios = require('axios');
var nodemailer = require('nodemailer');
const crypto = require('crypto');
const Joi = require('joi');
const alert = require('alert');



require("./utils.js");

const app = express();
const expireTime = 60 * 60 * 1000;
app.set('view engine', 'ejs')


// Load environment variables from .env file
require('dotenv').config();

const port = process.env.PORT || 3000;
const speechClient = new SpeechClient();
const mongoUri = process.env.MONGO_URI;
const nodeSessionSecret = process.env.NODE_SESSION_SECRET;

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true })); // Middleware to parse form data
// first, store files in memory as Buffer objects by using multer
const storage = multer.memoryStorage()
// telling multer to use the previously defined memory storage for storing the files.
const upload = multer({ storage: storage });
//to use EJS to render our ejs files as HTML
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/************ uploading profile images ***********/

let db, bucket;
// Initialize MongoDB and GridFS
// ensuring that the MongoDB connection 
// and GridFS initialization are completed before proceeding further.
async function initMongoDB() {
	const client = new MongoClient(mongoUri);
	try {
		await client.connect();
		db = client.db('BBY29');
		bucket = new GridFSBucket(db, { bucketName: 'profileImg' });
		console.log('Connected to MongoDB and GridFS initialized!');
	} catch (err) {
		console.error("Connection error:", err);
		process.exit(1);
	}
}
initMongoDB();


/* probably it will be used later on. leave it for now.

// Express route to get an image by filename
app.get('/images/:filename', async (req, res) => {
	try {
		// Assuming 'userId' is the key where the user ID is stored in the session

		const userId = req.session.userId;
		const downloadStream = bucket.openDownloadStreamByName(req.params.filename);

		// Set the proper content type before sending the stream
		downloadStream.on('file', (file) => {
			res.type(file.contentType);
		});
		// Pipe the image data to the response
		downloadStream.pipe(res);
	} catch (error) {
		console.error('Failed to retrieve image:', error);
		res.status(404).send('Image not found');
	}
});
*/

// Route to upload images
app.post('/upload', upload.single('image'), async (req, res) => {
	if (!req.file) {
		return res.status(400).send('No file uploaded.');
	}
	try {
		const filename = req.file.originalname;
		const fileId = await saveImageToMongoDB(req.file.buffer, req.file.mimetype, filename);
		res.send(`Image uploaded successfully with ID: ${fileId}`);

	} catch (error) {
		console.error('Upload error:', error);
		res.status(500).send(`Failed to upload image: ${error.message}`);
	}
});


/*********** connecting mongo ***************/



//if ur wondering why everything is inside this async connect-mongo call, blame davin, but at the same time it works?

async function connectToMongo() {
	const client = new MongoClient(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });


	try {
		await client.connect();
		console.log('Connected to MongoDB!');

		const db = client.db('BBY29');

		// Configure session middleware
		app.use(session({
			secret: nodeSessionSecret,
			resave: false,
			saveUninitialized: false,
			store: MongoStore.create({
				mongoUrl: mongoUri,
				dbName: 'BBY29',
				crypto: {
					secret: nodeSessionSecret,
					algorithm: 'aes-256-cbc',
					hash: {
						algorithm: 'sha256',
						iterations: 1000,
					},
				},
			}),
			cookie: {
				maxAge: 1 * 60 * 60 * 1000 // Session expiration (1 hour)
			}
		}));



		app.use("/scripts", express.static("./scripts"));
		app.use('/img', express.static('./img'));
		app.use('/styles', express.static('./styles'));
		app.use('/text', express.static('./text'));

		app.use(express.urlencoded({ extended: true })); // Middleware to parse form data

		//---------------------------------------------------
		// This code is provided by the Groq API library with
		// modification for our own project
		//---------------------------------------------------
		const Groq = require("groq-sdk");
		const groq = new Groq({
			apiKey: process.env.GROQ_API_KEY
		});


		//Valid Session Function
		function isValidSession(req) {
			if (req.session.authenticated) {
				return true;
			}
			return false;
		}

		//Session Validation Middleware
		function sessionValidation(req, res, next) {
			if (isValidSession(req)) {
				next();
			}
			else {
				res.redirect('/login');
			}
		}

		//Used chatgpt to help figure out the password
		const transporter = nodemailer.createTransport({
			service: 'gmail', // e.g., 'gmail', 'yahoo', etc.
			auth: {
				user: process.env.APP_EMAIL,
				pass: process.env.APP_PASSWORD
			}
		});

		//Index Page
		app.get('/', (req, res) => {
			if (req.session.authenticated) {
				res.redirect('/main');
			}
			else {
				res.render('index');
			}
		});

		//Sign up page
		app.get('/signup', (req, res) => {
			if (req.session.authenticated) {
				res.redirect('/main');
			}
			else {
				res.render('signup');
			}
		});

		//Shop Page
		app.get('/shop', sessionValidation, async (req, res) => {
			const usersCollection = db.collection('shopItems');
			const result = await usersCollection.find().project({}).toArray();
			const userCollection = db.collection('users');
			const results = await userCollection.find({ email: req.session.email }).project({ currentPoints: 1 }).toArray();
			console.log(results[0].currentPoints);
			req.session.currentPoints = results[0].currentPoints;
			res.render('shop', { items: result, currentPoints: results[0].currentPoints });
		});

		app.post('/buy/:name', sessionValidation, async (req, res) => {
			var itemName = req.params.name;
			var points = req.session.currentPoints;

			const shopItemCollection = db.collection('shopItems');
			const shopItems = await shopItemCollection.find({ name: itemName }).project({ price: 1 }).toArray();

			const userCollection = db.collection('users');
			const rerollAmount = await userCollection.find({ email: req.session.email }).project({ rerolls: 1 }).toArray();

			if (points < shopItems[0].price) {
				console.log("Not Enough Points.");
				return false;
			}
			const filter = { username: req.session.username };
			if (itemName == 'Task Reroll') {
				var rerolls = rerollAmount[0].rerolls;
				const updateDoc = {
					$set: {
						rerolls: rerolls + 1

					},
				};


				await userCollection.updateOne(filter, updateDoc);
				req.session.rerolls = rerolls;
			}

			var newprice = points - shopItems[0].price;
			console.log(newprice);
			const updateDoc = {
				$set: {
					currentPoints: newprice

				},
			};

			await userCollection.updateOne(filter, updateDoc);
			req.session.currentPoints = newprice;
			console.log("You bought a " + itemName);
			res.redirect('/shop');
			return true;

		});

		//FitTasks Page
		app.get('/fitTasks', sessionValidation, async (req, res) => {
			var point = req.session.points;
			const usersCollection = db.collection('users');
			const result = await usersCollection.find({ email: req.session.email }).project({ email: 1, username: 1, password: 1, points: 1, _id: 1, fitTasks: 1, rerolls: 1, date: 1 }).toArray();

			if (result[0].date != new Date().getDate()) {

				var taskBankFit = await db.collection('fitnessTasks').find({}).project({ task: 1 }).toArray();
				var userFitTasks = new Array(3);


				for (var i = 0; i < 3; i++) {
					while (true) {
						var temp = Math.floor(Math.random() * taskBankFit.length);
						if (taskBankFit[temp].task != userFitTasks[0] && taskBankFit[temp].task != userFitTasks[1] && taskBankFit[temp].task != userFitTasks[2]) {
							userFitTasks[i] = taskBankFit[temp].task;
							break;
						}
					}
				}

				var taskBankDiet = await db.collection('dietTasks').find({}).project({ task: 1 }).toArray();
				var userDietTasks = new Array(3);

				for (var i = 0; i < 3; i++) {
					while (true) {
						var temp = Math.floor(Math.random() * taskBankDiet.length);
						if (taskBankDiet[temp].task != userDietTasks[0] && taskBankDiet[temp].task != userDietTasks[1] && taskBankDiet[temp].task != userDietTasks[2]) {
							userDietTasks[i] = taskBankDiet[temp].task;
							break;
						}
					}
				}

				const updateDoc = {
					$set: {
						fitTasks: userFitTasks,
						dietTasks: userDietTasks,
						date: new Date().getDate()
					}
				}

				await usersCollection.updateOne(result[0], updateDoc);
				res.redirect('/fitTasks');
			} else {
				res.render('fitTasks', { points: point, task1: result[0].fitTasks[0], task2: result[0].fitTasks[1], task3: result[0].fitTasks[2], rerolls: result[0].rerolls, noRerolls: false });
			}

		});

		//DietTasks Page
		app.get('/dietTasks', sessionValidation, async (req, res) => {
			var point = req.session.points;
			const usersCollection = db.collection('users');
			const result = await usersCollection.find({ email: req.session.email }).project({ email: 1, username: 1, password: 1, points: 1, _id: 1, dietTasks: 1, rerolls: 1, date: 1 }).toArray();

			if (result[0].date != new Date().getDate()) {

				var taskBankFit = await db.collection('fitnessTasks').find({}).project({ task: 1 }).toArray();
				var userFitTasks = new Array(3);


				for (var i = 0; i < 3; i++) {
					while (true) {
						var temp = Math.floor(Math.random() * taskBankFit.length);
						if (taskBankFit[temp].task != userFitTasks[0] && taskBankFit[temp].task != userFitTasks[1] && taskBankFit[temp].task != userFitTasks[2]) {
							userFitTasks[i] = taskBankFit[temp].task;
							break;
						}
					}
				}

				var taskBankDiet = await db.collection('dietTasks').find({}).project({ task: 1 }).toArray();
				var userDietTasks = new Array(3);

				for (var i = 0; i < 3; i++) {
					while (true) {
						var temp = Math.floor(Math.random() * taskBankDiet.length);
						if (taskBankDiet[temp].task != userDietTasks[0] && taskBankDiet[temp].task != userDietTasks[1] && taskBankDiet[temp].task != userDietTasks[2]) {
							userDietTasks[i] = taskBankDiet[temp].task;
							break;
						}
					}
				}

				const updateDoc = {
					$set: {
						fitTasks: userFitTasks,
						dietTasks: userDietTasks,
						date: new Date().getDate()
					}
				}

				await usersCollection.updateOne(result[0], updateDoc);
				res.redirect('/dietTasks');
			} else {
				res.render('dietTasks', { points: point, task1: result[0].dietTasks[0], task2: result[0].dietTasks[1], task3: result[0].dietTasks[2], rerolls: result[0].rerolls });
			}

		});

		//Signup POST
		app.post('/signup', async (req, res) => {
			const usersCollection = db.collection('users');
			const { username, email, password } = req.body;

			// Validate input
			if (!username) {
				res.render('signup', { errorMessage: 'Name is required.' });
				return;
			}
			if (!email) {
				res.render('signup', { errorMessage: 'Email is required.' });
				return;
			}
			if (!password) {
				res.render('signup', { errorMessage: 'Password is required.' });
				return;
			}

			// Validate input format with Joi
			const schema = Joi.object({
				username: Joi.string().alphanum().max(20).required(),
				email: Joi.string().email().max(35).required(),
				password: Joi.string().max(20).required()
			});

			const { error } = schema.validate({ username, email, password });
			if (error) {
				res.render('signup', { errorMessage: `Validation error: ${error.details[0].message}` });
				return;
			}

			try {

				// Check if username or email already exists
				const existingUser = await usersCollection.findOne({
					$or: [{ username: username }, { email: email }]
				});

				if (existingUser) {
					let errorMessage = '';
					if (existingUser.username === username && existingUser.email === email) {
						errorMessage = 'Username and Email already exist.';
					} else if (existingUser.username === username) {
						errorMessage = 'Username already exists.';
					} else if (existingUser.email === email) {
						errorMessage = 'Email already exists.';
					}
					res.render('signup', { errorMessage: errorMessage });
					return;
				}

				// Hash the password
				const hashedPassword = await bcrypt.hash(password, saltRounds);

				var temp;

				var taskBankFit = await db.collection('fitnessTasks').find({}).project({ task: 1 }).toArray();
				var userFitTasks = new Array(3);


				for (var i = 0; i < 3; i++) {
					while (true) {
						temp = Math.floor(Math.random() * taskBankFit.length);
						if (taskBankFit[temp].task != userFitTasks[0] && taskBankFit[temp].task != userFitTasks[1] && taskBankFit[temp].task != userFitTasks[2]) {
							userFitTasks[i] = taskBankFit[temp].task;
							break;
						}
					}
				}

				var taskBankDiet = await db.collection('dietTasks').find({}).project({ task: 1 }).toArray();
				var userDietTasks = new Array(3);


				for (var i = 0; i < 3; i++) {
					while (true) {
						temp = Math.floor(Math.random() * taskBankDiet.length);
						if (taskBankDiet[temp].task != userDietTasks[0] && taskBankDiet[temp].task != userDietTasks[1] && taskBankDiet[temp].task != userDietTasks[2]) {
							userDietTasks[i] = taskBankDiet[temp].task;
							break;
						}
					}
				}

				// Insert the new user into the database
				const result = await usersCollection.insertOne({
					username,
					email,
					password: hashedPassword,
					timeCreated: new Date().getTime(),
					points: 0,
					user_rank: 'Bronze',
					fitTasks: userFitTasks,
					dietTasks: userDietTasks,
					date: new Date().getDate(),
					rerolls: 3
				});

				console.log("Inserted user");

				// Set session variables
				req.session.authenticated = true;
				req.session.userId = result.insertedId;
				req.session.username = username;
				req.session.points = 0;
				req.session.currentPoints = 0;
				req.session.rank = 'Bronze';
				req.session.cookie.maxAge = expireTime;
				req.session.email = email;

				res.redirect('/main');
			} catch (err) {
				console.error("Error registering user:", err);
				res.render('signup', { errorMessage: 'Failed to register user.' });
			}
		});

		//Login Page
		app.get('/login', (req, res) => {
			if (req.session.authenticated) {
				res.redirect('/main');
			}
			else {
				res.render('login', { input: 0 });
			}
		});

		//Login POST
		app.post('/login', async (req, res) => {

			const usersCollection = db.collection('users');
			var email = req.body.email;
			var password = req.body.password;

			const schema = Joi.string().max(35).required();
			const validationResult = schema.validate(email);
			if (validationResult.error != null) {
				res.render('login', { input: 1 });
				return;
			}

			const result = await usersCollection.find({ email: email }).project({ email: 1, username: 1, password: 1, points: 1, currentPoints: 1, rerolls: 1, _id: 1 }).toArray();

			console.log(result);
			if (result.length != 1) {
				res.render('login', { input: 1 });
				return;
			}
			if (await bcrypt.compare(password, result[0].password)) {
				console.log("correct password");
				req.session.authenticated = true;
				req.session.userId = result[0]._id;
				req.session.username = result[0].username;
				req.session.points = result[0].points;
				req.session.rank = result[0].user_rank;
				req.session.currentPoints = result[0].currentPoints;
				req.session.rerolls = result[0].rerolls;
				req.session.email = email;
				req.session.cookie.maxAge = expireTime;

				res.redirect('/main');
				return;
			}
			else {
				res.render('login', { input: 1 });
				return;
			}
		});

		//Log Out Page
		app.get('/logout', (req, res) => {
			//destroy session
			req.session.destroy(err => {
				if (err) {
					console.error('Error destroying session:', err);
				}
				res.redirect('/');
			});
		});

		app.get('/reset-email', (req, res) => {
			res.render('reset-email');
		});

		app.post('/reset-email', async (req, res) => {
			// Email url made with help of chatgpt
			const { email } = req.body;
			const sessionToken = crypto.randomBytes(32).toString('hex');
			try {
				await db.collection('passwordResetTokens').insertOne({ email, token: sessionToken });

				const resetUrl = `http://localhost:2800/reset-password?token=${sessionToken}`;
				const mailOptions = {
					from: process.env.APP_EMAIL,
					to: email,
					subject: 'Password Reset',
					html: `
                <p>Hello,</p>
                <p>You have requested to reset your password. Please click the link below to reset your password:</p>
                <a href="${resetUrl}">${resetUrl}</a>
                <p>This link will expire in 30 minutes.</p>
            `
				};

				await transporter.sendMail(mailOptions);
				res.send('Password reset email sent successfully. <br><a href="/">Back to home page</a>');
			}
			catch (error) {
				console.error('Error sending password reset email:', error);
				res.status(500).send('Failed to send password reset email.');
			}
		});

		app.get('/reset-password', async (req, res) => {
			const { token } = req.query;

			try {
				// Check if the session token exists in MongoDB
				const resetToken = await db.collection('passwordResetTokens').findOne({ token });

				if (!resetToken) {
					return res.status(400).send('Invalid or expired token.');
				}

				// Display the password reset form
				res.render('reset-password', { token });
			} catch (error) {
				console.error('Error fetching reset token:', error);
				res.status(500).send('Error resetting password.');
			}
		});

		// Route to handle password reset form submission
		app.post('/reset-password', async (req, res) => {
			const { token, newPassword, confirmNewPassword } = req.body;

			// Define Joi schema for password validation
			const schema = Joi.object({
				newPassword: Joi.string().min(8).max(20).required(),
				confirmNewPassword: Joi.string().valid(Joi.ref('newPassword')).required()
			});

			try {
				// Validate the incoming data
				const validationResult = schema.validate({ newPassword, confirmNewPassword });

				if (validationResult.error) {
					// Handle validation error
					return res.status(400).send('Invalid password or password confirmation.');
				}

				// Verify that the session token exists in MongoDB
				const resetToken = await db.collection('passwordResetTokens').findOne({ token });

				if (!resetToken) {
					return res.status(400).send('Invalid or expired token.');
				}

				// Hash the new password
				const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

				// Update the user's password in MongoDB
				await db.collection('users').updateOne({ email: resetToken.email }, { $set: { password: hashedPassword } });

				// Delete the reset token from MongoDB
				await db.collection('passwordResetTokens').deleteOne({ token });

				res.send('Password reset successful. <br><a href="/login">Back to login</a>');
			} catch (error) {
				console.error('Error resetting password:', error);
				res.status(500).send('Error resetting password.');
			}
		});

		app.get('/map', (req, res) => {
			// Resolve the path to map.html using path module
			const mapFilePath = path.join(__dirname, 'html', 'map.html');

			// Send map.html as the response
			res.sendFile(mapFilePath);
		});

		app.get('/aichat-home', (req, res) => {
			// Resolve the path to map.html using path module
			const mapFilePath = path.join(__dirname, 'html', 'aichat-home.html');

			// Send map.html as the response
			res.sendFile(mapFilePath);
		});

		app.get('/aichat-config', (req, res) => {
			// Resolve the path to map.html using path module
			const mapFilePath = path.join(__dirname, 'html', 'aichat-config.html');

			// Send map.html as the response
			res.sendFile(mapFilePath);
		});

		app.get('/aichat-loading', (req, res) => {
			// Resolve the path to map.html using path module
			const mapFilePath = path.join(__dirname, 'html', 'aichat-loading.html');

			// Send map.html as the response
			res.sendFile(mapFilePath);
		});

		app.get('/aichat-log', (req, res) => {
			// Resolve the path to map.html using path module
			const mapFilePath = path.join(__dirname, 'html', 'aichat-log.html');

			// Send map.html as the response
			res.sendFile(mapFilePath);
		});

		//main page - check the user, display the remained tasks, display the user name in the current session;
		app.get('/main', async (req, res) => {

			if (!req.session.authenticated) {
				console.log("nope");
				res.redirect('/login');  // Redirect to login if no user session
				return;
			}

			// greeting depends on the time user logged in
			const currentHour = new Date().getHours();
			let greeting;
			if (currentHour < 12) {
				greeting = 'Good Morning';
			} else if (currentHour < 18) {
				greeting = 'Good Afternoon';
			} else {
				greeting = 'Good Evening';
			}

			// ranking
			var currentPoints = req.session.points;
			console.log(currentPoints);
			if (currentPoints < 50 && currentPoints >= 0) {
				req.session.rank = 'Bronze';
				console.log('bronze');
			}
			else if (currentPoints > 49 && currentPoints < 100) {
				req.session.rank = 'Silver';
				console.log('silver');
			}
			else if (currentPoints > 99 && currentPoints < 150) {
				req.session.rank = 'Gold';
				console.log('gold');
			}
			else if (currentPoints > 149 && currentPoints < 200) {
				req.session.rank = 'Platinum';
				console.log('platinum');
			}
			else if (currentPoints > 199 && currentPoints < 250) {
				req.session.rank = 'Diamond';
				console.log('diamond');
			}
			else {
				req.session.rank = 'Limit Reached';
			}
			const filter = { username: req.session.username };

			const updateDoc = {
				$set: {
					user_rank: req.session.rank
				},
			};

			const usersCollection = db.collection('users');
			const result = await usersCollection.updateOne(filter, updateDoc);

			//let doc = fs.readFileSync('./html/main.html', 'utf8'); // Ensure this path is correct

			async function getAndSortUsersFromDB(limit = 5) {
				try {
					// Only return the data we need (excluding the password field)  // Sort by points in descending order
					const users = await usersCollection.find({}, { projection: { password: 0 } })
						.sort({ points: -1 })
						.limit(limit).toArray();
					return users;
				} catch (error) {
					console.error("Error retrieving users from the database:", error);
					return [];
				}
			}

			/************ To use the ejs template ***********/

			const username = req.session.username
			const points = req.session.points
			const rank = req.session.rank
			const users = await getAndSortUsersFromDB();
			let fitTasks = [];
			let dietTasks = [];

			try {
				const current_user = await usersCollection.findOne({ username: req.session.username });

				// Get tasks
				fitTasks = current_user.fitTasks.map(task => task);

				dietTasks = current_user.dietTasks.map(task => task);

			} catch (err) {
				console.error("Error fetching user or tasks:", err);
				res.status(500).send('Failed to fetch user data');
			}

			// console.log("username: " + username);
			// console.log("points: " + points);
			// console.log("rank: " + rank);
			// console.log("USERS: " + users);
			// console.log("tasks: " + tasks);

			res.render('main', {
				// Pass data to the template here
				username,
				rank,
				points,
				users,
				fitTasks,
				dietTasks,
				greeting
			});
		});

		app.post('/rerollFit', sessionValidation, async (req, res) => {

			var number = req.body.number;

			const usersCollection = db.collection('users');
			var result = await usersCollection.find({ email: req.session.email }).project({ email: 1, username: 1, password: 1, points: 1, _id: 1, fitTasks: 1, rerolls: 1, date: 1, user_rank: 1 }).toArray();

			var temp = '';
			var tempTasks;
			if (result[0].rerolls < 1) {
				var point = req.session.points;
				res.render('fitTasks', { points: point, task1: result[0].fitTasks[0], task2: result[0].fitTasks[1], task3: result[0].fitTasks[2], rerolls: result[0].rerolls, noRerolls: true });
				return;
			}
			req.session.user_rank = result[0].user_rank;
			req.session.rerolls = result[0].rerolls;
			var randomVal = Math.random() * 10;
			var odds;

			if (req.session.user_rank == "Bronze") {
				odds = 1;
			} else if (req.session.user_rank == "Silver") {
				odds = 2;
			} else if (req.session.user_rank == "Gold") {
				odds = 5;
			} else if (req.session.user_rank == "Platinum") {
				odds = 8;
			} else if (req.session.user_rank == "Diamond") {
				odds = 10;
			}

			if (randomVal > odds) {
				tempTasks = db.collection('fitnessTasks');
			} else {
				tempTasks = db.collection('fitnessTasksHard');
			}

			var taskBankFit = await tempTasks.find({}).project({ task: 1 }).toArray();
			while (true) {
				temp = Math.floor(Math.random() * taskBankFit.length);
				if (taskBankFit[temp].task != result[0].fitTasks[0] && taskBankFit[temp].task != result[0].fitTasks[1] && taskBankFit[temp].task != result[0].fitTasks[2]) {
					break;
				}
			}

			//console.log(taskBankFit[temp].task);

			var updateDoc;

			if (number == 1) {
				updateDoc = {
					$set: {
						fitTasks: [taskBankFit[temp].task, result[0].fitTasks[1], result[0].fitTasks[2]],
						rerolls: req.session.rerolls - 1
					},
				};
			} else if (number == 2) {
				updateDoc = {
					$set: {
						fitTasks: [result[0].fitTasks[0], taskBankFit[temp].task, result[0].fitTasks[2]],
						rerolls: req.session.rerolls - 1
					},
				};
			} else if (number == 3) {
				updateDoc = {
					$set: {
						fitTasks: [result[0].fitTasks[0], result[0].fitTasks[1], taskBankFit[temp].task],
						rerolls: req.session.rerolls - 1
					},
				};
			}



			result = await usersCollection.updateOne(result[0], updateDoc);

			res.redirect('/fitTasks');
		});

		app.post('/rerollDiet', sessionValidation, async (req, res) => {

			var number = req.body.number;

			const usersCollection = db.collection('users');
			var result = await usersCollection.find({ email: req.session.email }).project({ email: 1, username: 1, password: 1, points: 1, _id: 1, dietTasks: 1, rerolls: 1, date: 1, user_rank: 1 }).toArray();

			var temp = '';
			var tempTasks;
			if (result[0].rerolls < 1) {
				var point = req.session.points;
				res.render('dietTasks', { points: point, task1: result[0].dietTasks[0], task2: result[0].dietTasks[1], task3: result[0].dietTasks[2], rerolls: result[0].rerolls, noRerolls: true });
				return;
			}
			req.session.user_rank = result[0].user_rank;
			req.session.rerolls = result[0].rerolls;
			var randomVal = Math.random() * 10;
			var odds;

			if (req.session.user_rank == "Bronze") {
				odds = 1;
			} else if (req.session.user_rank == "Silver") {
				odds = 2;
			} else if (req.session.user_rank == "Gold") {
				odds = 5;
			} else if (req.session.user_rank == "Platinum") {
				odds = 8;
			} else if (req.session.user_rank == "Diamond") {
				odds = 10;
			}

			if (randomVal > odds) {
				tempTasks = db.collection('dietTasks');
			} else {
				tempTasks = db.collection('dietTasksHard');
			}

			var taskBankFit = await tempTasks.find({}).project({ task: 1 }).toArray();
			while (true) {
				temp = Math.floor(Math.random() * taskBankFit.length);
				if (taskBankFit[temp].task != result[0].dietTasks[0] && taskBankFit[temp].task != result[0].dietTasks[1] && taskBankFit[temp].task != result[0].dietTasks[2]) {
					break;
				}
			}

			//console.log(taskBankFit[temp].task);

			var updateDoc;

			if (number == 1) {
				updateDoc = {
					$set: {
						dietTasks: [taskBankFit[temp].task, result[0].dietTasks[1], result[0].dietTasks[2]],
						rerolls: req.session.rerolls - 1
					},
				};
			} else if (number == 2) {
				updateDoc = {
					$set: {
						dietTasks: [result[0].dietTasks[0], taskBankFit[temp].task, result[0].dietTasks[2]],
						rerolls: req.session.rerolls - 1
					},
				};
			} else if (number == 3) {
				updateDoc = {
					$set: {
						dietTasks: [result[0].dietTasks[0], result[0].dietTasks[1], taskBankFit[temp].task],
						rerolls: req.session.rerolls - 1
					},
				};
			}

			console.log(updateDoc);

			result = await usersCollection.updateOne(result[0], updateDoc);

			console.log(result);

			res.redirect('/dietTasks');
		});


		//Adding points to Fitness Page
		app.post('/addPointFit', sessionValidation, async (req, res) => {

			const tasks1 = db.collection('fitnessTasks');
			const tasks2 = db.collection('fitnessTasksHard');
			const usersCollection = db.collection('users');
			var point = req.session.points;
			var currentPoint = req.session.currentPoints;
			var lookingTask = req.body.task;
			var addingPoints;

			var result1 = await tasks1.find({ task: lookingTask }).project({ points: 1 }).toArray();
			var result2 = await tasks2.find({ task: lookingTask }).project({ points: 1 }).toArray();

			if (result1.length > 0) {
				addingPoints = result1[0].points;
			} else if (result2.length > 0) {
				addingPoints = result2[0].points;
			}

			const updateDoc = {
				$set: {
					points: point + addingPoints,
					currentPoints: currentPoint + addingPoints

				},
			};

			await usersCollection.updateOne({ username: req.session.username }, updateDoc);
			req.session.points = point + addingPoints;
			req.session.currentPoints = currentPoint + addingPoints;

			res.redirect('/fitTasks');
		});

		//Adding points to Diet Page
		app.post('/addPointDiet', sessionValidation, async (req, res) => {

			const tasks1 = db.collection('dietTasks');
			const tasks2 = db.collection('dietTasksHard');
			const usersCollection = db.collection('users');
			var point = req.session.points;
			var currentPoint = req.session.currentPoints;
			var lookingTask = req.body.task;
			var addingPoints;

			var result1 = await tasks1.find({ task: lookingTask }).project({ points: 1 }).toArray();
			var result2 = await tasks2.find({ task: lookingTask }).project({ points: 1 }).toArray();

			if (result1.length > 0) {
				addingPoints = result1[0].points;

				console.log(result1.points);
			} else if (result2.length > 0) {
				addingPoints = result2[0].points;

				console.log(result2.points);
			}

			const updateDoc = {
				$set: {
					points: point + addingPoints,
					currentPoints: currentPoint + addingPoints
				},
			};

			await usersCollection.updateOne({ username: req.session.username }, updateDoc);
			req.session.points = point + addingPoints;
			req.session.currentPoints = currentPoint + addingPoints;

			console.log(addingPoints);

			res.redirect('/dietTasks');
		});

		app.post('/GroqChatCompletion', async (req, res) => {

			const userInput = req.body.question;
			try {
				const chatCompletion = await getGroqChatCompletion(userInput);
				res.json({
					message: chatCompletion.choices[0]?.message?.content,
				});
			} catch (error) {
				res.status(500).json({ error: error.message });
			}
		});

		async function getGroqChatCompletion(userInput) {
			return groq.chat.completions.create({
				messages: [
					{
						role: "user",
						content: userInput
					}
				],
				model: "mixtral-8x7b-32768"
			});
		}

		// module.exports = {
		//     main,
		//     getGroqChatCompletion
		// };

		/****************** getting Images *************************/

		// Express route to get a profile image by user id
		app.get('/images/:userId', async (req, res) => {
			try {
				console.log("Session User ID: " + req.params.userId)
				const userId = req.params.userId;
				// Find the file in the MongoDB GridFS bucket by metadata userId
				const files = await bucket.find({ "metadata.userId": userId }).toArray();
				console.log("Files: " + files)
				if (files.length === 0) {
					// If no images found, serve the default image
					const defaultImagePath = './img/default-avatar.jpg';
					res.sendFile(defaultImagePath, { root: __dirname });
				} else {

					// There is only one profile picture
					const file = files[0];

					// Open a download stream by the file ID
					const downloadStream = bucket.openDownloadStream(file._id);

					// Set the proper content type before sending the stream
					downloadStream.on('file', (file) => {
						res.type(file.metadata.contentType);
					});

					// Pipe the image data to the response
					downloadStream.pipe(res);

				}

			} catch (error) {
				console.error('Failed to retrieve image:', error);
				res.status(500).send('Failed to retrieve image due to an internal error.');
			}
		});

		app.get('/profile', sessionValidation, async (req, res) => {
			console.log(req.session.userId);
			const uploadSuccess = req.session.uploadSuccess;
			req.session.uploadSuccess = false; // Reset the flag immediately
			res.render('profile', { userID: req.session.userId, username: req.session.username, email: req.session.email, uploadSuccess: uploadSuccess });
		});

		//ChangeEmail Page
		app.get('/changeEmail', sessionValidation, async (req, res) => {
			res.render('changeEmail');
		});

		app.post('/changeEmail', sessionValidation, async (req, res) => {
			const filter = { username: req.session.username };
			const email = req.body.email;

			const schema = Joi.object(
				{
					email: Joi.string().max(35).required()
				}
			);

			if (schema.validate({ email }) != null) {
				const updateDoc = {
					$set: {
						email: email
					}
				};

				const usersCollection = db.collection('users');
				await usersCollection.updateOne(filter, updateDoc);
				req.session.email = email;

				res.redirect('profile');
			} else {

				res.redirect('changeEmail');
			}

		});

		//ChangePassword Page
		app.get('/changePassword', sessionValidation, async (req, res) => {
			res.render('changePassword');
		});

		app.post('/changePassword', sessionValidation, async (req, res) => {
			const filter = { username: req.session.username };
			const password = req.body.password;

			const schema = Joi.object(
				{
					password: Joi.string().min(8).max(20).required()
				}
			);

			if (schema.validate({ password }) != null) {
				const updateDoc = {
					$set: {
						password: await bcrypt.hash(password, saltRounds)
					}
				};

				const usersCollection = db.collection('users');
				await usersCollection.updateOne(filter, updateDoc);

				res.redirect('profile');
			} else {

				res.redirect('changePassword');
			}

		});

		//ChangePassword Page
		app.get('/changeUsername', sessionValidation, async (req, res) => {
			res.render('changeUsername');
		});

		app.post('/changeUsername', sessionValidation, async (req, res) => {
			const filter = { email: req.session.email };
			const username = req.body.username;

			const schema = Joi.object(
				{
					username: Joi.string().min(8).max(20).required()
				}
			);

			if (schema.validate({ username }) != null) {
				const updateDoc = {
					$set: {
						username: username
					}
				};

				const usersCollection = db.collection('users');
				await usersCollection.updateOne(filter, updateDoc);
				req.session.username = username;

				res.redirect('profile');
			} else {

				res.redirect('changeUsername');
			}

		});

		// Route to upload profile images
		app.post('/profile-upload', upload.single('image'), async (req, res) => {
			if (!req.file) {
				return res.status(400).send('No file uploaded.');
			}
			try {
				console.log("session user id: " + req.session.userId);
				const userId = req.session.userId;
				const filename = req.file.originalname;
				await saveProfileImageToMongoDB(req.file.buffer, req.file.mimetype, filename, userId);
				// Reset the flag after rendering
				req.session.uploadSuccess = true;
				res.redirect('/profile');
			} catch (error) {
				console.error('Upload error:', error);
				res.status(500).send(`Failed to upload image: ${error.message}`);
			}
		});

		// ----------------------------------------------------------
		// This code is partially provided in the Google Speech to Text API, 
		// which is modified with the help of GroqCloud AI API to connect 
		// client side to handle audio streaming from the client side.

		app.post('/transcribe', async (req, res) => { // This is the end point for posting to the Google Speech API
			const audioStream = req.pipe(require('stream')); // Create a transcription request by piping the incoming request stream 
			// to a stream created by the 'stream' package


			// Create the Speech-to-Text API request
			// Google Client libraries
			const request = {
				config: {
					encoding: 'LINEAR16',
					sampleRateHertz: 16000,
					languageCode: 'en-US',
				},
				audio: {
					content: audioStream,
				},
			};

			// Send the request to the Speech-to-Text API, store the response, and process the transcription
			const [response] = await speechClient.recognize(request);
			const transcription = response.results
				.map(result => result.alternatives[0].transcript)
				.join('\n');

			res.json({ transcription });
		});

		app.post('/audio', (req, res) => { // This is the end point for receiving audio and initiating transcription
			const audioStream = req.pipe(fs.createWriteStream('audio.wav')); // Create a writable stream for the audio file named 'audio.wav' to save the incoming request data

			// Add event listener for when the 'finish' event is triggered on the stream. 
			// Once the entire request stream is processed, initiate transcription by calling the 'getTranscription' function
			audioStream.on('finish', () => {
				console.log('Received audio data, initiating transcription.');
				getTranscription();
			});

			res.json({ status: 'received' });
		});

		// Initiates a transcription request using the Google Cloud Speech-to-Text API
		function getTranscription() {
			const audioStream = fs.createReadStream('audio.wav'); // Create a readable stream for the previously saved 'audio.wav' file

			// Google Speech API configuration settings
			const request = {
				config: {
					encoding: 'LINEAR16',
					sampleRateHertz: 16000,
					languageCode: 'en-US',
				},
				audio: {
					content: audioStream,
				},
			};

			// Google Client libraries code with modification for the client side display
			speechClient.recognize(request)
				.then(data => {
					const transcription = data[0].results
						.map(result => result.alternatives[0].transcript)
						.join('\n');

					console.log(`Transcription: ${transcription}`);
				})
				.catch(err => {
					console.error('Error occurred:', err);
				});
		}

		app.get('/ai-training-home', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-home.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-questions', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-questions.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-scan-request', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-scan-request.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-camera-feed', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-camera-feed.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-female-body-scan', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-female-body-scan.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-female-body-scan-result', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-female-body-scan-result.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-male-body-scan', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-male-body-scan.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-male-body-scan-result', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-male-body-scan-result.html', 'utf-8');
			res.send(doc);
		});

		app.get('/ai-training-recommendation', (req, res) => {
			var doc = fs.readFileSync('./html/ai-training-recommendation.html', 'utf-8');
			res.send(doc);
		});

		// Route for handling 404 Not Found
		app.get('*', (req, res) => {
			res.status(404).send('Page not found - 404');
		});

		app.listen(port, () => {
			console.log("Node appplication listening on port " + port);
		});


	} catch (err) {
		console.error("Connection error:", err);
		process.exit(1); // Exit with error if connection fails
	}
}
connectToMongo().catch(console.error);


/************************ helper functions to upload profile images ***************************/


async function saveProfileImageToMongoDB(fileBuffer, contentType, filename, userId) {
	// This function specifically saves profile images and ensures only one exists per user.
	try {
		return await saveImageToMongoDB(fileBuffer, contentType, filename, userId, 320, 320, true);
	} catch (error) {
		console.error('Failed to save profile image:', error);
		throw error;
	}
}

// Save image to MongoDB using GridFS
async function saveImageToMongoDB(fileBuffer, contentType, filename, userId, width, height, allowOneImageOnly) {
	try {
		// Resize the image before uploading for profile picture
		const resizedBuffer = await resizeImage(fileBuffer, width, height);

		const metadata = {
			contentType: contentType,
			userId: userId
		};

		if (allowOneImageOnly) {
			// Check if a file already exists for the given userId
			const existingFiles = await bucket.find({ "metadata.userId": userId }).toArray();
			if (existingFiles.length > 0) {
				// Assuming there is only one image per user, replace the existing one
				await bucket.delete(existingFiles[0]._id);
			}
		}

		const uploadStream = bucket.openUploadStream(filename, { metadata: metadata });
		uploadStream.write(resizedBuffer);
		uploadStream.end();

		return new Promise((resolve, reject) => {
			uploadStream.on('finish', () => resolve(uploadStream.id));
			uploadStream.on('error', (error) => {
				console.error('Failed to save image:', error);
				reject(error);
			});
		});

	} catch (error) {
		console.error('Failed to save image:', error);
		throw error;
	}
}

// resize Images
async function resizeImage(fileBuffer, width, height) {
	try {
		// Resize the image
		const resizedBuffer = await sharp(fileBuffer)
			.resize(width, height)
			.toBuffer();
		return resizedBuffer;
	} catch (error) {
		console.error('Error resizing image:', error);
		throw error;
	}
}
