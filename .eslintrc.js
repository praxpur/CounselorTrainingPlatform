/*
 * Eslint config file
 * Documentation: https://eslint.org/docs/user-guide/configuring/
 * Install the Eslint extension before using this feature.
 */
module.exports = {
  root: true,
  env: {
    es2021: true,
    browser: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  globals: {
    wx: 'readonly',
    App: 'readonly',
    Page: 'readonly',
    Component: 'readonly',
    Behavior: 'readonly',
    getCurrentPages: 'readonly',
    getApp: 'readonly',
    requirePlugin: 'readonly',
    requireMiniProgram: 'readonly',
  },
  ignorePatterns: ['node_modules/', 'miniprogram_npm/'],
  extends: ['eslint:recommended'],
  rules: {
    // 逻辑与代码质量
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off',
    'no-var': 'error',
    'prefer-const': 'warn',
    eqeqeq: ['error', 'always', { null: 'ignore' }],

    // 代码风格（与当前项目保持一致）
    indent: ['error', 2, { SwitchCase: 1 }],
    quotes: ['error', 'single', { avoidEscape: true }],
    semi: ['error', 'never'],
    'comma-dangle': ['error', 'always-multiline'],
    'object-curly-spacing': ['error', 'always'],
    'array-bracket-spacing': ['error', 'never'],
    'arrow-parens': ['error', 'always'],
  },
}
