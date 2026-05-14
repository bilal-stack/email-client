import { inngest } from "@/lib/inngest/client";
import { serve } from "inngest/next";

// Function list starts empty; sync + AI jobs land in their respective specs.
export const { GET, POST, PUT } = serve({ client: inngest, functions: [] });
