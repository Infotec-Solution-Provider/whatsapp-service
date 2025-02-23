import "dotenv/config";
import express from "express";

const app = express();
const appPort = Number(process.env["APP_PORT"]) || 5000;

app.listen(appPort, () => {
    console.log(`Server running on port ${appPort}`);
});
