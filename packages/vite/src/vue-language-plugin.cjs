// The plugin of @vue/language-core that gives vue-tsc and the Vue editor
// tools the TypeScript types of Go components (language.js). The language
// tools load their plugins with require(), so this entry is CommonJS.
"use strict";
module.exports = require("./language.js").vueLanguagePlugin;
