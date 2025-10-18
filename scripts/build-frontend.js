const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const isDev = process.argv.includes("--watch");

// Plugin to inject CSS into the bundle
const cssPlugin = {
  name: "css",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await fs.promises.readFile(args.path, "utf8");
      const contents = `
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
      `;
      return { contents, loader: "js" };
    });
  },
};

const buildOptions = {
  entryPoints: [path.join(__dirname, "../src/frontend/index.tsx")],
  bundle: true,
  outfile: path.join(__dirname, "../public/dist/bundle.js"),
  platform: "browser",
  target: ["es2020"],
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
  },
  plugins: [cssPlugin],
  minify: !isDev,
  sourcemap: isDev,
  define: {
    "process.env.NODE_ENV": isDev ? '"development"' : '"production"',
  },
};

async function build() {
  try {
    if (isDev) {
      const context = await esbuild.context(buildOptions);
      await context.watch();
      console.log("👀 Watching for changes...");
    } else {
      await esbuild.build(buildOptions);
      console.log("✅ Build completed successfully!");
    }
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

build();
