import { expect, test } from "@playwright/test";

test("Inngest route handler responds", async ({ request }) => {
  const response = await request.get("/api/inngest");
  expect(response.status()).toBeLessThan(500);
});
