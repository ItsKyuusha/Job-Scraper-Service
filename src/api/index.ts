// Vercel serverless entry point.
// @vercel/node akan mengkompilasi file ini langsung (tanpa perlu dist/).
// File ini hanya mere-export Express app dari src/index.ts sebagai default export,
// yang dikenali Vercel sebagai request handler.

import app from "../index.js";

export default app;
