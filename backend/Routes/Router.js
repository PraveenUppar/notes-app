const express = require("express");
const router = express.Router(); // this will handle all requests
const jwt = require("jsonwebtoken");
const multer = require("multer");
const bcrypt = require("bcrypt");
const { HTTP_STATUS, MESSAGES, ERROR_MESSAGES } = require("../utils/const");
const dotenv = require("dotenv");
const path = require("path");
const rateLimit = require("express-rate-limit");

const fs = require("fs");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/userModel");
const Note = require("../models/noteModel");
const Contact = require("../models/contactModel");
const Feedback = require("../models/feedbackModel");
const { sendVerificationMail } = require("../mail/forgotPAsswordOtpMail");

require('dotenv').config();
const { ACCESS_TOKEN_SECRET, GOOGLE_API_TOKEN } = process.env;

const client = new OAuth2Client(GOOGLE_API_TOKEN);

const envPath =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env";
dotenv.config({ path: path.resolve(__dirname, envPath) });

// configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath);
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

// rate limiter middleware
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 15 minutes
  max: 6, // Limit each IP to 5 login requests per windowMs
  message: {
    error: true,
    message:
      "Too many login attempts from this IP, please try again after 5 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({ storage: storage });
//upload multiple attachments files
const uploadMultiple = multer({ storage: storage }).array("attachments", 10);

// Authentication middleware
const authenticationToken = (req, res, next) => {
  const token = req.headers["authorization"].split(" ")[1];
  console.log("Authorization header:", token); // Log the token for debugging

  if (!token) {
    return res.status(403).json({ message: "No token provided." });
  }

  jwt.verify(token, ACCESS_TOKEN_SECRET, (err, user) => {
    if (err) {
      console.error("Token verification error:", err); // Log the error
      return res.status(403).json({ message: "Token verification failed." });
    }
    req.user = user; // Attach user data to the request object
    next(); // Proceed to the next middleware/route handler
  });
};

router.post("/contact", async (req, res) => {
    const { first_name, last_name, user_email, message } = req.body;

    try {
      // Create a new contact entry
      const contact = new Contact({
        first_name,
        last_name,
        user_email,
        message,
      });

      // Save the contact information to the database
      await contact.save();

      // Here you would typically send the email
      const html = `<p>${message}</p>`;
      const name = first_name + " " + last_name;

      // (Email sending logic would go here)

      return res.status(200).json({
        error: false,
        message: "Mail sent successfully and information saved",
      });
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({
        error: true,
        message: "Internal error",
      });
    }
});

router.post("/create-account", async (req, res) => {
  const { fullName, email, password } = req.body;

  // fullname validations
  if (!fullName || fullName.trim() === "") {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.NAME_REQUIRED });
  }
  const nameRegex = /^[A-Za-z]+(?: [A-Za-z]+)*$/;
  if (!nameRegex.test(fullName)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.INVALID_NAME_FORMAT });
  }

  // email validations
  if (!email || email.trim() === "") {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.EMAIL_REQUIRED });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.INVALID_EMAIL_FORMAT });
  }

  // password validaitons
  if (!password || password.trim() === "") {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.PASSWORD_REQUIRED });
  }
  if (!/[A-Z]/.test(password)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: true,
      message: ERROR_MESSAGES.PASSWORD_UPPERCASE_REQUIRED,
    });
  }
  if (!/[a-z]/.test(password)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: true,
      message: ERROR_MESSAGES.PASSWORD_LOWERCASE_REQUIRED,
    });
  }
  if (!/[!"#$%&'()*+,-.:;<=>?@[\]^_`{|}~]/.test(password)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: true,
      message: ERROR_MESSAGES.PASSWORD_SPECIAL_CHAR_REQUIRED,
    });
  }
  if (!(password.length >= 8)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.PASSWORD_MIN_LENGTH });
  }

  const isUser = await User.findOne({ email });
  if (isUser) {
    return res.json({
      error: true,
      message: ERROR_MESSAGES.USER_ALREADY_EXISTS,
    });
  }
  //password is already hashed as we used pre and hashed it  before saving the User - info

  const user = new User({ fullName, email, password });
  await user.save();
  const expiresIn = 60 * 20;
  const token = jwt.sign({ sub: user._id, expiresIn }, ACCESS_TOKEN_SECRET);
  const url = `http://localhost:${process.env.PORT}/verify/${token}`;
  const html = `<a href="${url}">Click here to verify your account</a>`;

  const accessToken = jwt.sign({ user }, ACCESS_TOKEN_SECRET, {
    expiresIn: "36000m",
  });

  return res.json({
    error: false,
    user,
    accessToken,
    message: "Registration Successful",
  });
});

router.get("/verify/:token", async (req, res) => {
  const { token } = req.params;
  if (!token) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.INVALID_TOKEN });
  }

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
    const { sub: userId } = decoded;

    const user = await User.findById(userId);
    if (!user) {
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json({ error: true, message: ERROR_MESSAGES.USER_NOT_FOUND });
    }

    user.isEmailVerified = true;
    await user.save();

    return res.json({
      error: false,
      message: MESSAGES.EMAIL_VERIFIED_SUCCESSFULLY,
    });
  } catch (error) {
    console.error("Error verifying email: ", error);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ error: true, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// Login
router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ message: ERROR_MESSAGES.EMAIL_PASSWORD_REQUIRED });
  }


  const userInfo = await User.findOne({ email });

  if (!userInfo || !userInfo.checkPassword(password)) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ message: ERROR_MESSAGES.INVALID_CREDENTIALS });
    }
    //console.log("hii");
  // if (!userInfo.isEmailVerified) {
  //   return res
  //     .status(HTTP_STATUS.BAD_REQUEST)
  //     .json({ message: ERROR_MESSAGES.EMAIL_NOT_VERIFIED });
  // }

  const accessToken = jwt.sign({ user: userInfo }, ACCESS_TOKEN_SECRET, {
    expiresIn: "36000m",
  });

  return res.json({
    error: false,
    message: "Login Successful",
    user: userInfo,
    accessToken,
  });
});

// Protected Routes
router.get("/get-user", authenticationToken, async (req, res) => {
  try {
    const { user } = req.user;
    if (!user) return res.sendStatus(HTTP_STATUS.UNAUTHORIZED);

    const isUser = await User.findOne({ _id: user._id });
    return res.json({
      user: {
        fullName: isUser.fullName,
        email: isUser.email,
        _id: isUser._id,
        createdOn: isUser.createdOn,
      },
      message: "",
    });
  } catch (error) {
    console.error("Error fetching user: ", error);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ error: true, message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// delete user and its notes
router.delete("/delete-user", authenticationToken, async (req, res) => {
  try {
    // destructuring to get userID
    const {
      user: { _id: userId },
    } = req.user;
    if (!userId) {
      return res.status(400).json({ error: true, message: "User Id required" });
    }

    // deleting notes
    const deleteNotesResult = await Note.deleteMany({ userId });

    // deleting user
    const deleteUserResult = await User.findByIdAndDelete(userId);

    // checking if user doesn't exist
    if (!deleteUserResult) {
      return res.status(404).json({ error: true, message: "User not found " });
    }
    return res.json({ error: false, message: "User deleted successfully" });
  } catch (error) {
    console.log("Error while deleting user", { error });
    return res
      .status(500)
      .json({ error: true, message: "Something went wrong" });
  }
});

router.put("/update-fullName", authenticationToken, async (req, res) => {
  const { user } = req.user;
  const { newFullName } = req.body;

  if (!user) {
    console.error("User not authenticated");
    return res
      .status(HTTP_STATUS.UNAUTHORIZED)
      .json({ error: ERROR_MESSAGES.USER_NOT_AUTHENTICATED });
  }

  console.log("User ID:", user._id);
  console.log("New Full Name:", newFullName);

  try {
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { fullName: newFullName },
      { new: true }
    );

    if (!updatedUser) {
      console.error("User not found");
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json({ error: ERROR_MESSAGES.USER_NOT_FOUND });
    }

    console.log("Name updated successfully", updatedUser);
    return res.status(HTTP_STATUS.OK).json({
      message: MESSAGES.FULLNAME_UPDATED_SUCCESSFULLY,
      user: updatedUser,
    });
  } catch (error) {
    console.error("Error updating Name: ", error);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// Update email
router.put("/update-email", authenticationToken, async (req, res) => {
  const { user } = req.user;
  const { newEmail } = req.body;

  if (!user) {
    console.error("User not authenticated");
    return res
      .status(HTTP_STATUS.UNAUTHORIZED)
      .json({ error: ERROR_MESSAGES.USER_NOT_AUTHENTICATED });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(newEmail)) {
    return res
      .status(400)
      .json({ error: true, message: "Invalid Email format" });
  }

  try {
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { email: newEmail },
      { new: true }
    );

    if (!updatedUser) {
      console.error("User not found");
      return res
        .status(HTTP_STATUS.NOT_FOUND)
        .json({ error: ERROR_MESSAGES.USER_NOT_FOUND });
    }

    console.log("Email updated successfully", updatedUser);
    return res.status(HTTP_STATUS.OK).json({
      message: MESSAGES.EMAIL_UPDATED_SUCCESSFULLY,
      user: updatedUser,
    });
  } catch (error) {
    console.error("Error updating email: ", error);
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
  }
});

// Update phone
router.put("/update-phone", async (req, res) => {
  const { newPhone } = req.body;
  const userId = req.body.userId;

  try {
    const user = await User.findById(userId);
    if (user) {
      user.phone = newPhone;
      await user.save();
      res
        .status(HTTP_STATUS.OK)
        .json({ message: MESSAGES.PHONE_UPDATED_SUCCESSFULLY });
    } else {
      res
        .status(HTTP_STATUS.NOT_FOUND)
        .json({ message: ERROR_MESSAGES.USER_NOT_FOUND });
    }
  } catch (error) {
    res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR, error });
  }
});

// Update profile photo
router.put(
  "/update-profile-photo",
  upload.single("profilePhoto"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "Profile photo is required" });
    }

    try {
      const userId = req.body.userId;
      const profilePhotoPath = `/uploads/${req.file.filename}`;

      await User.findByIdAndUpdate(userId, { profilePhoto: profilePhotoPath });

      res.status(200).json({
        message: "Profile photo updated successfully",
        profilePhoto: `http://localhost:8000${profilePhotoPath}`,
      });
    } catch (error) {
      console.error("Error updating profile photo:", error);
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json({ message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
    }
  }
);

//google oauth
router.post("/google-auth", async (req, res) => {
  const { token } = req.body;

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_API_TOKEN,
    });

    const payload = ticket.getPayload();
    const userid = payload["sub"];
    const email = payload["email"];

    let user = await User.findOne({ email });

    if (!user) {
      user = new User({
        fullName: payload["name"],
        email: email,
        password: "", // You might want to generate a random password or handle this differently
      });
      await user.save();
    }

    const accessToken = jwt.sign({ user }, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "36000m",
    });

    res.json({
      error: false,
      user,
      accessToken,
      message: MESSAGES.GOOGLE_AUTH_SUCCESSFUL,
    });
  } catch (error) {
    console.error(error);
    res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json({ error: true, message: ERROR_MESSAGES.INVALID_GOOGLE_TOKEN });
  }
});

//verify email
router.post("/verify-email", async(req, res)=>{
  const {email} = req.body;

  const existingUser = await User.findOne({ email: email });
  if (!existingUser) {
    return res.status(404).json({ error: "Email is not registered" });
  }

  const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

  existingUser.verificationCode = verifyCode;
  await existingUser.save();


  try {
    sendVerificationMail(email, verifyCode);
    res.status(201).json({ id: existingUser._id, success: true });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
})

// verify OTP
router.post("/verify-otp", async(req, res)=>{
  try {
    const { id, otp } = req.body;

    const existingUser = await User.findOne({ _id: id });

    if (!existingUser) {
        return res.status(404).json({ error: "User not found" });
    }

    if(existingUser.verificationCode !== otp){
        return res.status(400).json({ error: "Invalid verification code", success: false });
    }

    existingUser.verificationCode = ""
    await existingUser.save();

    return res.status(200).json({ message: "verified", success: true})
  } catch (error) {
      return res.status(500).json({ message: "Internal server error", success: false})
  }
})

router.post("/reset-password", async(req, res)=>{
  try {
    const {id, password} = req.body

    const user = await User.findOne({ _id: id });
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    user.password = password;
    await user.save();
    res.json({ message: "Password reset successful" });
  } catch (error) {
    res.status(501).json({ error: "Internal server error" });
  }
})

// feedback submit
router.post("/submit", async (req, res) => {
  const { name, email, feedback, rating } = req.body;

  try {
    const newFeedback = new Feedback({
      name,
      email,
      feedback,
      rating,
    });

    await newFeedback.save();
    res
      .status(HTTP_STATUS.CREATED)
      .json({ message: MESSAGES.FEEDBACK_SUBMITTED_SUCCESSFULLY });
  } catch (error) {
    res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .json({ message: ERROR_MESSAGES.FAILED_TO_SUBMIT_FEEDBACK, error });
  }
});

module.exports = router;
