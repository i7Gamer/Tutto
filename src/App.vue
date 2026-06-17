<template>
  <div id="app"><TuttoGame/></div>
</template>

<script>
import TuttoGame from "./components/TuttoGame";

export default {
  name: "App",
  components: {
    TuttoGame
  }
};
</script>

<style>
#app {
  font-family: "Avenir", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
}
</style>
