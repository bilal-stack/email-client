import { inngest } from "@/lib/inngest/client";
import { inngestFunctions } from "@/lib/inngest/functions";
import { serve } from "inngest/next";

// Functions are aggregated in `lib/inngest/functions/index.ts`. Each spec
// appends its function to that list rather than touching this file directly.
export const { GET, POST, PUT } = serve({ client: inngest, functions: inngestFunctions });
