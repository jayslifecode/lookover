import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dev-tools badge is a button Lookover would crawl as if it were part of the app.
  devIndicators: false,
  // `next dev` would otherwise write an AGENTS.md here whenever it runs under a coding agent.
  agentRules: false,
};

export default nextConfig;
