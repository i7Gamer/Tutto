// The Vue build version to load with the `import` command
// (runtime-only or standalone) has been set in webpack.base.conf with an alias.

/* eslint-disable no-new */

import { createApp } from 'vue'
import App from './App.vue'

// import vuetify from './plugins/vuetify';
import 'vuetify/styles'
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'

// Create Vuetify instance
const vuetify = createVuetify({
  components,
  directives,
  theme: { defaultTheme: 'light' },
})

//export default createVuetify()

import VueGraph from 'vue-graph'

const app = createApp(App)
app.use(VueGraph)
app.use(vuetify)
app.mount('#app')

/*
import Vue from "vue";
import App from './App.vue'
import SmartTable from "vuejs-smart-table";
import {
  MdButton,
  MdContent,
  MdField,
  MdTable,
  MdDialog,
  MdDialogConfirm
} from "vue-material/dist/components";
import "vue-material/dist/vue-material.min.css";
import VueMaterial from "vue-material";
import VueGraph from "vue-graph";

Vue.config.productionTip = false;
Vue.use(SmartTable);
Vue.use(VueGraph);
Vue.use(MdButton);
Vue.use(MdContent);
Vue.use(MdField);
Vue.use(MdTable);
Vue.use(MdDialog);
Vue.use(MdDialogConfirm);

Vue.use(VueMaterial); */

/*new Vue({
  render: (h) => h(App),
}).$mount("#app");*/


 /*new Vue({
  el: "#app",
  components: { App },
  template: "<App/>"
});
*/