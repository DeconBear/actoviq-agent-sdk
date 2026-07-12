import { defineConfig } from 'vitepress';

const zhSidebar = [
  {
    text: '中文教程',
    items: [
      { text: '教程首页', link: '/zh/README' },
      { text: '01 安装与快速开始', link: '/zh/01-setup-and-quickstart' },
      { text: '02 基础运行、流式输出与会话', link: '/zh/02-basic-run-stream-session' },
      { text: '03 工具、权限、Skills 与 MCP', link: '/zh/03-tools-permissions-mcp' },
      { text: '04 Agents、Swarm、Memory 与 Workspace', link: '/zh/04-agents-swarm-memory-workspace' },
      { text: '05 测试、排错与速查', link: '/zh/05-testing-troubleshooting-cheatsheet' },
      { text: '06 从 0 到 1 做完整 Clean Agent', link: '/zh/06-build-a-complete-clean-agent' },
      { text: '07 Workflow 编排', link: '/zh/07-workflow-orchestration' },
      { text: '08 SDK 架构审计与优化规划', link: '/zh/08-sdk-architecture-audit-and-optimization-plan' },
      { text: '09 SDK 1.0 迁移指南', link: '/zh/09-sdk-v2-migration-guide' },
      { text: '10 支持、安全与 SemVer', link: '/zh/10-support-security-semver-and-failure-model' },
      { text: '11 JSON v1 → SQLite Runbook', link: '/zh/11-json-v1-to-sqlite-migration-runbook' },
      { text: '12 SDK 1.0 实施验收报告', link: '/zh/12-sdk-1.0-implementation-and-verification-report' },
    ],
  },
];

const enSidebar = [
  {
    text: 'English Guide',
    items: [
      { text: 'Guide Home', link: '/en/README' },
      { text: '01 Setup and Quickstart', link: '/en/01-setup-and-quickstart' },
      { text: '02 Run, Stream, and Session Basics', link: '/en/02-basic-run-stream-session' },
      { text: '03 Tools, Permissions, Skills, and MCP', link: '/en/03-tools-permissions-skills-mcp' },
      { text: '04 Agents, Swarm, Memory, and Workspace', link: '/en/04-agents-swarm-memory-workspace' },
      { text: '05 Testing, Troubleshooting, and Cheatsheet', link: '/en/05-testing-troubleshooting-cheatsheet' },
      { text: '06 Build a Complete Clean Agent', link: '/en/06-build-a-complete-clean-agent' },
      { text: '07 Workflow Orchestration', link: '/en/07-workflow-orchestration' },
    ],
  },
];

const blogSidebar = [
  {
    text: 'Blog',
    items: [
      { text: 'Overview', link: '/blog/' },
      { text: 'Model Team & Agent Design Research', link: '/blog/model-team-agent-design' },
    ],
  },
];

export default defineConfig({
  title: 'Actoviq Agent SDK',
  description: 'Actoviq 1.0 SDK docs for provider-neutral, durable, multi-agent runtimes.',
  base: '/actoviq-agent-sdk/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'English', link: '/en/README' },
      { text: '中文', link: '/zh/README' },
      { text: 'Blog', link: '/blog/' },
      { text: 'GitHub', link: 'https://github.com/DeconBear/actoviq-agent-sdk' },
      { text: 'npm', link: 'https://www.npmjs.com/package/actoviq-agent-sdk' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/DeconBear/actoviq-agent-sdk' }],
    sidebar: {
      '/en/': enSidebar,
      '/zh/': zhSidebar,
      '/blog/': blogSidebar,
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 deconbear',
    },
  },
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/' },
          { text: 'English Guide', link: '/en/README' },
          { text: '中文教程', link: '/zh/README' },
          { text: 'Blog', link: '/blog/' },
          { text: 'GitHub', link: 'https://github.com/DeconBear/actoviq-agent-sdk' },
          { text: 'npm', link: 'https://www.npmjs.com/package/actoviq-agent-sdk' },
        ],
        sidebar: {
          '/en/': enSidebar,
          '/blog/': blogSidebar,
        },
      },
    },
    zh: {
      label: '中文',
      lang: 'zh-CN',
      link: '/zh/README',
      themeConfig: {
        nav: [
          { text: '首页', link: '/' },
          { text: 'English', link: '/en/README' },
          { text: '中文教程', link: '/zh/README' },
          { text: 'GitHub', link: 'https://github.com/DeconBear/actoviq-agent-sdk' },
          { text: 'npm', link: 'https://www.npmjs.com/package/actoviq-agent-sdk' },
        ],
        sidebar: {
          '/zh/': zhSidebar,
        },
      },
    },
  },
});
