// ESLint flat config —— 最小规则集：recommended + no-unused-vars 调优。
// 定位：接替 scripts/check-syntax.js 的语法门，并额外抓 AI 维护代码库的高发错误
// （跨文件改名漏改 no-undef、死变量 no-unused-vars）。刻意不引入风格/格式化规则。
import js from '@eslint/js';
import globals from 'globals';
import unusedImports from 'eslint-plugin-unused-imports';

export default [
  {
    // vendor 为第三方压缩产物、docs 为落地页产物、其余为运行时/测试生成物
    ignores: [
      'node_modules/**',
      'app/public/vendor/**',
      'app/public/test-snapshots/**',
      'docs/**',
      'data/**',
      '.ccm-uploads/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      '.bug-hunter/**',
      '.codegraph/**',
      '.reasonix/**',
      '.worktrees/**',
      'tests/infra/playground/seed/**',
      // 安卓壳（mobile/）的两处前端【生成物】——都是 app/public 的副本，不是源码：
      //   · mobile/www：prepare-www.mjs 从 app/public 复制而来
      //   · mobile/android/.../assets/public：cap sync 再把 www 复制进安卓工程
      // 源文件在 app/public/js 已被下面的浏览器侧规则覆盖；lint 副本等于把同一份代码
      // 报两遍（且副本没有 eslint 的 browser globals 上下文，会误报 no-undef）。
      // 二者都已 gitignore（不入库），但本地 ESLint 仍会扫工作区，故在此显式排除。
      'mobile/www/**',
      'mobile/android/app/src/main/assets/public/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // 死 import 用插件规则（可 --fix 自动清除，AI 编辑后的高发残留）；
      // 其余未用变量仍报错但不自动删（删变量可能改语义，须人工判断）
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Node 侧：后端源码、维护脚本、测试
  {
    // scripts 与 mobile/scripts 都含 .mjs（ESM 脚本：prepare-www.mjs / set-secrets.mjs），
    // 此前只写 *.js 会让它们落到默认无 globals 的上下文，console/process 被误报 no-undef。
    files: ['app/server.js', 'app/src/**/*.js', 'scripts/**/*.{js,mjs}', 'mobile/scripts/**/*.{js,mjs}', 'tests/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // 浏览器侧：native-ESM PWA
  {
    files: ['app/public/js/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // `t` 在前端专属 i18n（app/public/js/i18n.js）。把它当临时变量名会静默遮蔽成
      // 「t is not a function」——页面运行时才炸，而 no-undef 看不出问题（t 确实有定义）。
      // 这类 bug 只有真跑 E2E 才会暴露，代价太高，所以在这里一次性拦掉。
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclarator > Identifier[name="t"]',
          message: '别用 t 作局部变量名：会遮蔽 i18n 的 t()，运行时报 "t is not a function"。换个名字（textEl / entry / touch …）。',
        },
        {
          selector: ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > Identifier.params[name="t"]',
          message: '别用 t 作参数名：会遮蔽 i18n 的 t()，运行时报 "t is not a function"。换个名字。',
        },
        // 上面两条都要求节点【恰好是裸 Identifier】，于是解构 / catch / rest / 默认值 / 函数声明
        // 这些同样会绑定 t 的形式全部放行 —— 规则给出的安全感高于实际覆盖。实测漏网：
        // const { t } = o · const [t] = a · catch (t) · function f(...t) · function f({ t })
        // · function f(t = 1) · function t() {} · class t {}。补齐。
        {
          selector: 'ObjectPattern > Property > Identifier.value[name="t"]',
          message: '别用 t 作解构目标名：会遮蔽 i18n 的 t()，运行时报 "t is not a function"。改用 `{ t: tt }` 之类重命名。',
        },
        {
          selector: 'ArrayPattern > Identifier[name="t"]',
          message: '别用 t 作数组解构目标名：会遮蔽 i18n 的 t()。换个名字。',
        },
        {
          selector: 'CatchClause > Identifier.param[name="t"]',
          message: '别用 t 作 catch 参数名：会遮蔽 i18n 的 t()。用 err / e。',
        },
        {
          selector: 'RestElement > Identifier[name="t"]',
          message: '别用 t 作 rest 参数名：会遮蔽 i18n 的 t()。换个名字。',
        },
        {
          selector: 'AssignmentPattern > Identifier.left[name="t"]',
          message: '别用 t 作带默认值的参数名：会遮蔽 i18n 的 t()。换个名字。',
        },
        {
          // i18n.js 自身是 t() 的定义处，由下方独立 block 豁免。
          selector: ':matches(FunctionDeclaration, ClassDeclaration) > Identifier.id[name="t"]',
          message: '别把函数/类命名为 t：会遮蔽 i18n 的 t()。换个名字。',
        },
      ],
    },
  },
  // i18n.js 是 t() 的【定义处】，上面那组「别用 t 作标识符」的规则对它不适用（否则
  // `export function t(zh)` 自己就被判违规）。只豁免这一个文件，其余 app/public/js/** 照常受管。
  {
    files: ['app/public/js/i18n.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // 经典 <script>（非 ESM）：tw-config 写入 tailwind 全局、sw-cleanup 操作 navigator
  {
    files: ['app/public/js/tw-config.js', 'app/public/js/sw-cleanup.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, tailwind: 'writable' },
    },
  },
  // Service Worker 上下文
  {
    files: ['app/public/sw.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
];
