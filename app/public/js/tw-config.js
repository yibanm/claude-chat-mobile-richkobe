// Tailwind 运行时配置（CSP script-src 'self'：必须外置脚本、不可内联；在 vendor/tailwind.js 之后加载）。
// 把 M3 设计 token（:root CSS 变量，定义见 app/public/css/app.css）桥接为语义工具类——
// 用 bg-canvas / text-accent / border-line 这类**预设类**（JIT 成熟、active:/focus: 变体齐全、可读），
// 而非 bg-[var(--x)] 任意值类（运行时对动态注入元素的任意值 JIT 是边缘路径）。改色只动 :root，一处生效。
//
// 两套并存是有意的：项目原有的语义名（canvas/surface/ink/line/accent…）承载几百处现有标记，
// 值已换成 M3 色阶但名字不动，故零改动；新增的 M3 role 名（primary/on-primary/surface-container…）
// 只给新 M3 组件用。改色仍只动 app.css 的 :root 一处。
tailwind.config = {
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        surface: 'var(--surface)',
        sunk: 'var(--surface-sunk)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        'ink-faint': 'var(--ink-faint)',
        accent: {
          DEFAULT: 'var(--accent)',
          deep: 'var(--accent-deep)',
          bright: 'var(--accent-bright)',
          wash: 'var(--accent-wash)',
        },
        cta: 'var(--cta)',
        user: 'var(--user-bubble)',
        info: 'var(--info)',
        success: 'var(--success)',
        danger: 'var(--danger)',
        warning: 'var(--warning)',
        line: 'var(--line)',
        'line-soft': 'var(--line-soft)',
        // ── M3 color roles：新组件按 M3 语义命名直接用，不必再记「accent 对应哪个 role」──
        primary: {
          DEFAULT: 'var(--m3-primary)',
          on: 'var(--m3-on-primary)',
          container: 'var(--m3-primary-container)',
          'on-container': 'var(--m3-on-primary-container)',
        },
        secondary: {
          DEFAULT: 'var(--m3-secondary)',
          on: 'var(--m3-on-secondary)',
          container: 'var(--m3-secondary-container)',
          'on-container': 'var(--m3-on-secondary-container)',
        },
        tertiary: {
          DEFAULT: 'var(--m3-tertiary)',
          on: 'var(--m3-on-tertiary)',
          container: 'var(--m3-tertiary-container)',
          'on-container': 'var(--m3-on-tertiary-container)',
        },
        outline: {
          DEFAULT: 'var(--m3-outline)',
          variant: 'var(--m3-outline-variant)',
        },
        // surface-container 五层：M3 用「色调位移」表达 elevation（不是阴影），层级由低到高
        'surface-container': {
          lowest: 'var(--m3-surface-container-lowest)',
          low: 'var(--m3-surface-container-low)',
          DEFAULT: 'var(--m3-surface-container)',
          high: 'var(--m3-surface-container-high)',
          highest: 'var(--m3-surface-container-highest)',
        },
        'on-surface': {
          DEFAULT: 'var(--m3-on-surface)',
          variant: 'var(--m3-on-surface-variant)',
        },
        'inverse-surface': 'var(--m3-inverse-surface)',
        'inverse-on-surface': 'var(--m3-inverse-on-surface)',
      },
      fontFamily: {
        read: 'var(--font-read)',
      },
      // 【刻意不覆盖 borderRadius】项目里 rounded-lg(71 处) / rounded-xl(72 处) 用的是 tailwind 默认
      // 圆角值（8px / 12px）。在这里把它们映射到 --radius-*（16px / 28px）会静默改掉全站 143 处标记的
      // 圆角，超出「先核心面」的范围。M3 shape 由新组件直接写 var(--radius-xl) 等引用，见 app.css。
    },
  },
};
