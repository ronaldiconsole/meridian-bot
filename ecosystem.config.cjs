module.exports = {
  apps: [{
    name: 'meridian',
    script: 'index.js',
    env: {
      DRY_RUN: 'true',
      NODE_ENV: 'production'
    }
  }]
};
