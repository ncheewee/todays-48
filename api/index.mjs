import pg from "pg";
import { createApp } from "./app.mjs";

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  : null;
pool?.on("error", () => {});

export default createApp({ pool });
