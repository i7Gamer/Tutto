<template>
  <div class="hello overflow-auto">
	<v-dialog v-model="endGameActive" max-width="400">
	  <v-card>
		<v-card-title class="text-h6">Really end game?</v-card-title>
		<v-card-text>Are you sure?</v-card-text>
		<v-card-actions>
		  <v-spacer></v-spacer>
		  <v-btn text @click="continueGame">No</v-btn>
		  <v-btn text @click="endGame">Yes</v-btn>
		</v-card-actions>
	  </v-card>
	</v-dialog>
	
	<v-dialog v-model="continueGameActive" max-width="400">
	  <v-card>
		<v-card-title class="text-h6">Continue game?</v-card-title>
		<v-card-text>It seems like you left the website during a game. Do you want to continue?</v-card-text>
		<v-card-actions>
		  <v-spacer></v-spacer>
		  <v-btn text @click="continueGame">Continue</v-btn>
		  <v-btn text @click="endGame">Cancel</v-btn>
		</v-card-actions>
	  </v-card>
	</v-dialog>

    <div v-if="playing">
      <div class="currentStatus">
        <table class="currentStatusTable">
          <thead>
            <tr>
              <th>Player</th>
              <!-- <th>Card</th> -->
              <th>Round</th>
              <th>Score</th>
              <!-- <th>Pos.</th> -->
              <th>Playtime</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tbody>
            <tr>
              <td>
                <b>{{ currentPlayer.name }}</b>
              </td>
              <!-- <td>{{ currentCard }}</td> -->
              <td>{{ round }}</td>
              <td>{{ currentPlayer.score }}</td>
              <!-- <td>{{ currentPlayer.position }}</td> -->
              <td>{{ gameTimeReadable }}</td>
            </tr>
          </tbody>
        </table>

        <div class="currentCardAndPlayers">
          <div class="currentCard">
            <div v-if="currentCard === '200'">
              <img src="./../assets/200.png" />
            </div>
            <div v-if="currentCard === '300'">
              <img src="./../assets/300.png" />
            </div>
            <div v-if="currentCard === '400'">
              <img src="./../assets/400.png" />
            </div>
            <div v-if="currentCard === '500'">
              <img src="./../assets/500.png" />
            </div>
            <div v-if="currentCard === '600'">
              <img src="./../assets/600.png" />
            </div>
            <div v-if="currentCard === 'x2'">
              <img src="./../assets/x2.png" />
            </div>
            <div v-if="currentCard === 'Feuerwerk'">
              <img src="./../assets/Feuerwerk.png" />
            </div>
            <div v-if="currentCard === 'Stop'">
              <img src="./../assets/Stop.png" />
            </div>
            <div v-if="currentCard === 'Kleeblatt'">
              <img src="./../assets/Kleeblatt.png" />
            </div>
            <div v-if="currentCard === 'Plus_Minus'">
              <img src="./../assets/plusminus.png" />
            </div>
            <div v-if="currentCard === 'Kniffel'">
              <img src="./../assets/Kniffel.png" />
            </div>
          </div>
          <div class="transparent currentPlayers">
            <v-simple-table class="transparent">
              <v-simple-table-row>
                <v-simple-table-head>Pos.</v-simple-table-head>
                <v-simple-table-head>Name</v-simple-table-head>
                <v-simple-table-head>Score</v-simple-table-head>
              </v-simple-table-row>
              <v-simple-table-row
                v-for="player in sortedPlayers"
                :class="{
                  currentPlayer: player === currentPlayer,
                }"
                :key="player.name"
              >
                <v-simple-table-cell>{{ player.position }}.</v-simple-table-cell>
                <v-simple-table-cell>{{ player.name }}</v-simple-table-cell>
                <v-simple-table-cell>{{ player.score }}</v-simple-table-cell>
              </v-simple-table-row>
            </v-simple-table>
          </div>
        </div>
      </div>

      <v-text-field clearable class="flexItem score" v-if="currentCardHasInput">
        <label>Score</label>
        <v-text-field type="number" v-model.number="score"></v-text-field>
      </v-text-field>

      <div class="scoreButtons" v-if="currentCardHasInput">
        <v-btn class="v-btn" @click="addToScore(50)">50</v-btn>
        <v-btn class="v-btn" @click="addToScore(100)">100</v-btn>
        <v-btn class="v-btn" @click="addToScore(200)">200</v-btn>
        <v-btn class="v-btn" @click="addToScore(300)">300</v-btn>
        <v-btn class="v-btn" @click="addToScore(400)">400</v-btn>
        <v-btn class="v-btn" @click="addToScore(500)">500</v-btn>
        <v-btn class="v-btn" @click="addToScore(600)">600</v-btn>
        <v-btn class="v-btn" @click="addToScore(1000)">1000</v-btn>
      </div>

      <div class="yesNoButtons" v-if="currentCardHasYesNo">
        <v-btn class="v-btn" color="primary" @click="nextTurn(true)"
          >Yes</v-btn>
        <v-btn class="v-btn" color="secondary" @click="nextTurn(false)"
          >No</v-btn>
      </div>

      <div class="nextTurnAndUndo">
        <div v-if="previousCard != null && previousCard != 'Stop'">
          <v-btn class="undo" color="secondary" @click="undo()">Undo</v-btn>
        </div>

        <div class="nextTurn" v-if="!currentCardHasYesNo">
          <v-btn class="v-btn" color="primary" @click="nextTurn()"
            >Next Turn
		  </v-btn>
        </div>
      </div>
    </div>

    <div v-if="finished && winner">
      <h1>Winner: {{ winner.name }}</h1>
      <h3>Played rounds: {{ round }}</h3>
      <h3>Playtime: {{ gameTimeReadable }}</h3>

      <v-table :data="sortedPlayers" class="resultTable">
        <thead>
          <tr>
            <th>Spieler</th>
            <th v-for="player in sortedPlayers" :key="player.name">
              {{ player.name }}
            </th>
          </tr>
        </thead>
        <tbody></tbody>
        <tbody>
          <tr>
            <td>Platzierung</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.position }}.
            </td>
          </tr>
          <tr>
            <td>Punkte</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.score }}
            </td>
          </tr>
          <tr>
            <td>-1000</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.times1000PointsDeducted }}
            </td>
          </tr>
          <tr>
            <td>Plus/Minus</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.timesPlusMinusCompleted }}/{{
                player.timesPlusMinusFailed
              }}
            </td>
          </tr>
          <tr>
            <td>Kniffel</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.timesKniffelCompleted }}/{{ player.timesKniffelFailed }}
            </td>
          </tr>
          <tr>
            <td>Ausgelassen</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.timesSkipped }}
            </td>
          </tr>
          <tr>
            <td>Feuerwerk</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.timesFeuerwerkReceived }}
            </td>
          </tr>
          <tr>
            <td>Kleeblatt</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.timesKleeblattFailed }}
            </td>
          </tr>
          <tr>
            <td>x2</td>
            <td v-for="player in sortedPlayers" :key="player.name">
              {{ player.timesx2Received }}
            </td>
          </tr>
        </tbody>
      </v-table>

      <v-btn class="v-btn" color="primary" @click="restart">Restart game</v-btn>

      <graph-line
        :width="400"
        :height="300"
        :shape="'normal'"
        :background="'#fafafa'"
        :axis-min="lowestScore"
        :axis-max="winningScore"
        :axis-full-mode="true"
        :labels="chartLabels"
        :names="chartNames"
        :values="chartValues"
      >
        <note :text="'Score per round'"></note>
        <tooltip :names="chartNames" :position="'right'"></tooltip>
        <legends :names="chartNames"></legends>
        <guideline :tooltip-y="true"></guideline>
      </graph-line>
    </div>

    <div v-if="!currentPlayer && !finished">
      <v-btn class="v-btn" color="primary" @click="startGame">Start game!</v-btn>

      <table class="playerlist">
        <tr v-for="player in sortedPlayers">
          <td>{{ player.name }}</td>
          <td>
            <v-btn class="v-btn" @click="removePlayer(player)">Remove player</v-btn>
          </td>
        </tr>
      </table>

      <div class="addNewPlayer">
        <v-field clearable class="flexItem addNewPlayerField">
          <label>Name of new Player</label>
          <v-text-field type="text" v-model="newPlayerName"></v-text-field>
        </v-field>

        <v-btn class="v-btn flexItem addNewPlayerButton"
          @click="addNewPlayer()">
          Add player
        </v-btn>
      </div>

      <v-btn density="compact" color="primary" @click="toggleAdvancedOptions()">
        Toggle advanced options
      </v-btn>

      <div v-if="advancedOptions === true">
        <div class="changeScore">
          <v-text-field class="flexItem addNewPlayerField">
            <label>Winning score</label>
            <v-text-field type="number" v-model.number="winningScore"></v-text-field>
          </v-text-field>
        </div>

        <p>Change number of cards in deck:</p>
        <v-text-field class="changeCardNumbers">
          <label>Feuerwerk</label>
          <v-text-field
            type="number"
            v-model.number="initialCards.Feuerwerk"
          ></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>Stop</label>
          <v-text-field type="number" v-model.number="initialCards.Stop"></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>Kleeblatt</label>
          <v-text-field
            type="number"
            v-model.number="initialCards.Kleeblatt"
          ></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>x2</label>
          <v-text-field type="number" v-model.number="initialCards.x2"></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>Kniffel</label>
          <v-text-field
            type="number"
            v-model.number="initialCards.Kniffel"
          ></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>Plus/Minus</label>
          <v-text-field
            type="number"
            v-model.number="initialCards.Plus_Minus"
          ></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>200</label>
          <v-text-field type="number" v-model.number="initialCards[200]"></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>300</label>
          <v-text-field type="number" v-model.number="initialCards[300]"></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>400</label>
          <v-text-field type="number" v-model.number="initialCards[400]"></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>500</label>
          <v-text-field type="number" v-model.number="initialCards[500]"></v-text-field>
        </v-text-field>

        <v-text-field class="changeCardNumbers">
          <label>600</label>
          <v-text-field type="number" v-model.number="initialCards[600]"></v-text-field>
        </v-text-field>
      </div>
    </div>
    <div v-else>
      <v-btn class="v-btn" color="secondary" @click="endGameButton">End game</v-btn>
    </div>
  </div>
</template>

<script>
export default {
  name: "TuttoGame",
  data() {
    return {
      lowestScore: 0,
      gameTimeInSeconds: 0,
      gameTimeInterval: null,
      chartValues: [],
      chartNames: [],
      chartLabels: [],
      endGameActive: false,
      continueGameActive: false,
      advancedOptions: false,
      round: 1,
      previousScore: null,
      previousCard: null,
      previousLeaders: null,
      score: null,
      winningScore: 6000,
      newPlayerName: "",
      initialCards: {
        Kleeblatt: 1,
        Feuerwerk: 5,
        Stop: 10,
        Kniffel: 5,
        Plus_Minus: 5,
        x2: 5,
        200: 5,
        300: 5,
        400: 5,
        500: 5,
        600: 5,
      },
      cards: [],
      players: [
        {
          name: "Timo",
          score: 0,
          times1000PointsDeducted: 0,
          timesKniffelCompleted: 0,
          timesPlusMinusCompleted: 0,
          timesKniffelFailed: 0,
          timesKleeblattFailed: 0,
          timesPlusMinusFailed: 0,
          timesSkipped: 0,
          timesFeuerwerkReceived: 0,
          timesx2Received: 0,
          position: 0,
        },
      ],
      currentPlayerIndex: null,
      currentCard: null,
      winnerIndex: null,
      finished: false,
    };
  },
  mounted() {
    if (localStorage.players) {
      this.players = JSON.parse(localStorage.getItem("players"));

      if (JSON.parse(localStorage.getItem("currentPlayerIndex")) != null) {
        this.continueGameActive = true;
      }
    }
  },

  computed: {
    currentCardHasInput() {
      return (
        Number.isInteger(parseInt(this.currentCard)) ||
        this.currentCard === "x2" ||
        this.currentCard === "Feuerwerk"
      );
    },
    gameTimeReadable() {
      var seconds = this.gameTimeInSeconds;
      var minutes = Math.floor(seconds / 60);
      var hours = Math.floor(minutes / 60);

      seconds = seconds % 60;
      minutes = minutes % 60;

      if (minutes < 10) {
        minutes = "0" + minutes;
      }
      if (hours < 10) {
        hours = "0" + hours;
      }
      if (seconds < 10 && minutes != "00") {
        seconds = "0" + seconds;
      }

      if (hours === "00" && minutes == "00") {
        return seconds;
      } else if (hours === "00") {
        return minutes + ":" + seconds;
      } else {
        return hours + ":" + minutes + ":" + seconds;
      }
    },
    currentCardHasYesNo() {
      return ["Plus_Minus", "Kniffel", "Kleeblatt"].includes(this.currentCard);
    },

    playing() {
      return this.currentPlayer && !this.finished;
    },

    winner() {
      const winners = [...this.players]
        .filter((p) => p.score >= this.winningScore)
        .sort((a, b) => b.score - a.score);

      return winners.length ? winners[0] : null;
    },

    totalPlayers() {
      return this.players.length;
    },

    currentPlayer() {
      return this.players[this.currentPlayerIndex];
    },

    leaders() {
      var leaders = [...this.sortedPlayers];
      const score = leaders[0].score;

      var i = 1;
      while (i < leaders.length) {
        if (leaders[i].score != score) {
          leaders.splice(i, 1);
        } else {
          i++;
        }
      }
      return leaders;
      //return this.sortedPlayers.length ? this.sortedPlayers[0] : null;
    },

    sortedPlayers() {
      const players = [...this.players].sort((a, b) => b.score - a.score);

      for (var i = 0; i < players.length; i++) {
        if (i > 0 && players[i].score == players[i - 1].score) {
          players[i].position = players[i - 1].position;
        } else {
          if (i == 0) {
            players[i].position = 1;
          } else {
            players[i].position = players[i - 1].position + 1;
          }
        }
      }
      return players;
    },
  },

  watch: {
    winner() {
      if (this.winner && this.winnerIndex === null) {
        this.winnerIndex = this.players.findIndex(
          (p) => p.name === this.winner.name
        );
      } else if (!this.winner && this.winnerIndex) {
        this.winnerIndex = null;
      }
    },

    cards() {
      if (this.cards.length === 0) {
        this.shuffleCards();
      }
    },
    finished() {
      if (this.finished === true) {
        this.stopGameTimer();
      }
    },
  },

  methods: {
    startGame() {
      this.resetVariables();
      this.resetPlayerList();

      this.startGameTimer();
      this.currentPlayerIndex = 0;
      this.players = this.shuffleArray(this.players);
      this.shuffleCards();
      this.pickCard();
      this.createValues();
      this.saveCurrentState();
    },
    startGameTimer() {
      this.gameTimeInterval = setInterval(
        function () {
          this.gameTimeInSeconds++;
        }.bind(this),
        1000
      );
    },
    stopGameTimer() {
      clearInterval(this.gameTimeInterval);
    },
    createValues() {
      for (var i = 0; i < this.players.length; i++) {
        this.chartNames.push(this.players[i].name);
        this.chartValues.push([]);
      }
    },
    setValues() {
      for (var i = 0; i < this.players.length; i++) {
        this.chartValues[i].push(this.players[i].score);
      }
      this.chartLabels.push(this.round);
    },
    removeValues() {
      for (var i = 0; i < this.players.length; i++) {
        this.chartValues[i].splice(this.chartValues[i].length - 1, 1);
      }
      this.chartLabels.splice(this.chartLabels.length - 1, 1);
    },
    continueGame() {
      this.continueGameActive = false;
      this.round = localStorage.getItem("currentRound");
      this.currentCard = localStorage.getItem("currentCard");
      this.gameTimeInSeconds = localStorage.getItem("gameTimeInSeconds");

      this.startGameTimer();

      this.currentPlayerIndex = JSON.parse(
        localStorage.getItem("currentPlayerIndex")
      );
      this.cards = JSON.parse(localStorage.getItem("cards"));
      this.chartValues = JSON.parse(localStorage.getItem("chartValues"));
      this.chartNames = JSON.parse(localStorage.getItem("chartNames"));
      this.chartLabels = JSON.parse(localStorage.getItem("chartLabels"));
      this.finished = JSON.parse(localStorage.getItem("finished"));
    },
    pickCard() {
      const cards = [...this.cards];
      this.currentCard = cards.shift();
      this.cards = cards;
    },

    restart() {
      this.endGame();
      this.startGame();
    },

    inArray(needle, haystack) {
      var length = haystack.length;
      for (var i = 0; i < length; i++) {
        if (haystack[i] == needle) return true;
      }
      return false;
    },

    nextTurn(check = false) {
      let score = this.score;
      if (this.currentCard === "Plus_Minus" && check) {
        score = 1000;

        var leaders = [...this.leaders];

        if (!this.inArray(this.currentPlayer, leaders)) {
          this.previousLeaders = leaders;
          for (var i = 0; i < leaders.length; i++) {
            leaders[i].times1000PointsDeducted++;
            leaders[i].score -= 1000;
          }
        } else {
          this.previousLeaders = null;
        }
        this.currentPlayer.timesPlusMinusCompleted++;
      } else if (this.currentCard === "Plus_Minus") {
        this.currentPlayer.timesPlusMinusFailed++;
      }

      if (this.currentCard == "x2") {
        this.currentPlayer.timesx2Received++;
      }

      if (this.currentCard == "Feuerwerk") {
        this.currentPlayer.timesFeuerwerkReceived++;
      }

      if (this.currentCard === "Stop") {
        this.currentPlayer.timesSkipped++;
      }

      if (this.currentCard === "Kniffel" && check) {
        score = 2000;
        this.currentPlayer.timesKniffelCompleted++;
      } else if (this.currentCard === "Kniffel") {
        this.currentPlayer.timesKniffelFailed++;
      }

      if (this.currentCard === "Kleeblatt" && check) {
        this.players[this.currentPlayerIndex].score = 999999;
        this.finished = true;
        return;
      } else if (this.currentCard === "Kleeblatt") {
        this.currentPlayer.timesKleeblattFailed++;
      }

      if (this.score === "") {
        score = 0;
      }

      this.players[this.currentPlayerIndex].score += score;

      this.previousCard = this.currentCard;
      this.previousScore = score;

      this.nextPlayer();
      this.pickCard();

      if (this.players[this.currentPlayerIndex].score < this.lowestScore) {
        this.lowestScore = this.players[this.currentPlayerIndex].score;
      }

      this.score = null;
      this.saveCurrentState();
    },
    saveCurrentState() {
      localStorage.setItem("currentPlayerIndex", this.currentPlayerIndex);
      localStorage.setItem("currentRound", this.round);
      localStorage.setItem("currentCard", this.currentCard);
      localStorage.setItem("finished", this.finished);
      localStorage.setItem("gameTimeInSeconds", this.gameTimeInSeconds);

      localStorage.setItem("players", JSON.stringify(this.players));
      localStorage.setItem("cards", JSON.stringify(this.cards));
      localStorage.setItem("chartValues", JSON.stringify(this.chartValues));
      localStorage.setItem("chartNames", JSON.stringify(this.chartNames));
      localStorage.setItem("chartLabels", JSON.stringify(this.chartLabels));
    },
    nextPlayer() {
      if (this.currentPlayerIndex === this.totalPlayers - 1) {
        // round finished - if anyone above winningScore now, he won the game
        if (this.winner) {
          // check for multiple winners, only end game if there is only one clear winner
          if (this.winner.score != this.sortedPlayers[1].score) {
            this.finished = true;
            this.setValues();
            return;
          }
        }
        this.currentPlayerIndex = 0;
        this.setValues();
        this.round++;
      } else {
        this.currentPlayerIndex++;
      }
    },

    undo() {
      // do nothing if old card was stop because there is nothing to undo
      if (this.previousCard == "Stop" || this.previousCard == null) {
        return;
      }

      // change player index
      if (this.currentPlayerIndex === 0) {
        this.currentPlayerIndex = this.totalPlayers - 1;
        this.round--;
        // undo set values TODO
        this.removeValues();
      } else {
        this.currentPlayerIndex--;
      }

      if (this.currentCard == "Feuerwerk") {
        this.currentPlayer.timesFeuerwerkReceived--;
      }

      // undo plus/minus
      if (this.previousCard == "Plus_Minus" && this.previousLeaders != null) {
        for (var i = 0; i < this.previousLeaders.length; i++) {
          this.previousLeaders[i].score += 1000;
          this.previousLeaders[i].times1000PointsDeducted--;
        }
      }

      if (this.previousCard == "Plus_Minus" && this.previousScore === 1000) {
        this.currentPlayer.timesPlusMinusCompleted--;
      } else if (this.previousCard == "Plus_Minus") {
        this.currentPlayer.timesPlusMinusFailed--;
      }

      if (this.previousCard == "x2") {
        this.currentPlayer.timesx2Received--;
      }

      // reset kniffel counter
      if (this.previousCard === "Kniffel" && this.previousScore === 2000) {
        this.currentPlayer.timesKniffelCompleted--;
      } else if (this.previousCard === "Kniffel") {
        this.currentPlayer.timesKniffelFailed--;
      }

      // reset score and card, put old card back on top of cards
      this.cards.unshift(this.currentCard);
      this.currentCard = this.previousCard;
      this.currentPlayer.score -= this.previousScore;

      this.previousCard = null;
      this.previousLeaders = null;
      this.previousScore = null;
      this.saveCurrentState();
    },

    shuffleCards() {
      const cards = Object.keys(this.initialCards).reduce((cards, c) => {
        const count = this.initialCards[c];

        for (let i = 1; i <= count; i++) {
          cards.push(c);
        }

        return cards;
      }, []);

      this.cards = this.shuffleArray(cards);
    },

    shuffleArray(array) {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }

      return array;
    },
    removePlayer(player) {
      const playerIndex = this.players.findIndex((p) => p.name === player.name);
      this.players.splice(playerIndex, 1);
      localStorage.setItem("players", JSON.stringify(this.players));
    },
    addNewPlayer() {
      if (this.newPlayerName === "") {
        return;
      }
      this.players.push({
        name: this.newPlayerName,
        score: 0,
        times1000PointsDeducted: 0,
        timesKniffelCompleted: 0,
        timesPlusMinusCompleted: 0,
        timesKniffelFailed: 0,
        timesKleeblattFailed: 0,
        timesPlusMinusFailed: 0,
        timesFeuerwerkReceived: 0,
        timesSkipped: 0,
        timesx2Received: 0,
        position: 0,
      });
      this.newPlayerName = "";

      localStorage.setItem("players", JSON.stringify(this.players));
    },
    doNotEndGame() {
      this.endGameActive = false;
    },
    endGame() {
      this.resetVariables();
      this.resetPlayerList();
      this.saveCurrentState();
      this.stopGameTimer();
    },
    resetVariables() {
      this.lowestScore = 0;
      this.gameTimeInSeconds = 0;
      this.chartValues = [];
      this.chartNames = [];
      this.chartLabels = [];
      this.continueGameActive = false;
      this.endGameActive = false;
      this.score = null;
      this.round = 1;
      this.currentPlayerIndex = null;
      this.currentCard = null;
      this.winnerIndex = null;
      this.previousCard = null;
      this.previousLeaders = null;
      this.previousScore = null;
      this.finished = false;
    },
    resetPlayerList() {
      this.players = this.players.map((p) => {
        p.score = 0;
        p.times1000PointsDeducted = 0;
        p.timesKleeblattFailed = 0;
        p.timesKniffelCompleted = 0;
        p.timesKniffelFailed = 0;
        p.timesPlusMinusCompleted = 0;
        p.timesPlusMinusFailed = 0;
        p.timesFeuerwerkReceived = 0;
        p.timesSkipped = 0;
        p.position = 0;
        p.timesx2Received = 0;
        return p;
      });

      localStorage.setItem("players", JSON.stringify(this.players));
    },
    addToScore(points) {
      this.score += points;
    },
    endGameButton() {
      if (this.playing == true) {
        this.endGameActive = true;
      } else {
        this.endGame();
      }
    },
    toggleAdvancedOptions() {
      if (this.advancedOptions == true) {
        this.advancedOptions = false;
      } else {
        this.advancedOptions = true;
      }
    },
  },
};
</script>
<style>
.yesNoButtons {
  display: flex;
  flex-direction: row;
  justify-content: center;
}

.yesNoButtons button {
  margin: 10px 20px 10px 20px;
  padding: 6px;
  font-size: 16pt;
}

.playerlist {
  margin-top: 10px;
  margin-bottom: 10px;
  margin-left: auto;
  margin-right: auto;
  font-size: 12pt;
}

.resultTable {
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 10px;
}

.resultTable td,
th {
  padding: 4px;
}

.addNewPlayer {
  display: flex;
  justify-content: center;
}

.addNewPlayerField {
  max-width: 200px;
}

.flexItem {
  margin: 5px;
}

.changeScore {
  display: flex;
  justify-content: center;
}

input {
  font-size: 12pt;
  padding: 0px;
}

.winningScore {
  width: 80px;
}

.currentStatusTable {
  margin-right: auto;
  margin-left: auto;
}

.undo {
  margin-right: 10px;
}

.score {
  font-size: 16pt;
  margin: 6px;
  max-width: 220px;
  margin-left: auto;
  margin-right: auto;
}

.cardTable {
  margin-right: auto;
  margin-left: auto;
}

.cardInput {
  width: 60px;
}

.density="compact" {
  margin: 8px;
  padding: 4px;
  font-size: 12pt;
}

.v-btn {
  font-size: 14pt;
  min-width: 30px;
}

.currentCardAndPlayers {
  display: flex;
  justify-content: center;
}

.currentPlayers {
  margin: 6px 10px 4px 10px;
  font-size: 12pt;
}

.currentCard {
  margin: 6px 10px 4px 10px;
}

.currentPlayer {
  background-color: var(--md-theme-default-primary, #448aff);
  color: var(--md-theme-default-text-primary-on-primary, #fff);
}

.v-simple-table-head-container {
  padding: 0px;
  height: 32px;
}

.v-simple-table-head-label {
  padding: 4px 4px 2px 2px;
  text-align: left;
}

.v-simple-table-cell-container {
  height: 32px;
  padding: 4px 4px 2px 2px;
}

.nextTurnAndUndo {
  display: flex;
  justify-content: center;
  margin-top: 10px;
  margin-bottom: 20px;
}

.v-simple-table-cell {
  height: 32px;
}

.addNewPlayerButton {
  min-width: 130px;
}

.transparent {
  background-color: transparent;
}

.transparent div {
  background-color: transparent !important;
}

.changeCardNumbers {
  max-width: 200px;
  margin-left: auto;
  margin-right: auto;
  margin-bottom: 12px;
}

svg {
  background-color: transparent !important;
}

@media only screen and (max-width: 362px) {
  .v-simple-table-head-container {
    padding: 0px;
    height: 24px;
  }

  .v-simple-table-head-label {
    padding: 4px 4px 2px 2px;
    text-align: left;
  }

  .v-simple-table-cell-container {
    height: 24px;
    padding: 4px 4px 2px 2px;
  }

  .nextTurnAndUndo {
    display: flex;
    justify-content: center;
    margin-top: 10px;
    margin-bottom: 20px;
  }

  .v-simple-table-cell {
    height: 24px;
  }
  .currentPlayers {
    margin: 4px 6px 2px 6px;
    font-size: 12pt;
  }

  .currentCard {
    margin: 4px 6px 2px 6px;
  }
}

@media (min-width: 600px) {
  .currentPlayers {
    margin: 8px 12px 6px 14px;
    font-size: 12pt;
  }

  .density="compact" {
    margin: 8px;
    padding: 4px;
    font-size: 14pt;
  }

  .v-btn {
    font-size: 18pt;
    min-width: 30px;
    height: 40px;
  }

  .yesNoButtons button {
    margin: 10px 20px 10px 20px;
    padding: 6px;
    font-size: 20pt;
    height: 44px;
  }

  .currentCard {
    margin: 8px 12px 6px 14px;
  }

  .currentPlayer {
    background-color: var(--md-theme-default-primary, #448aff);
    color: var(--md-theme-default-text-primary-on-primary, #fff);
  }

  .v-simple-table-head-container {
    height: 40px;
    font-size: 12pt;
  }

  .v-simple-table-head-label {
    padding: 8px 8px 4px 4px;
    text-align: left;
  }

  .v-simple-table-cell-container {
    height: 40px;
    padding: 8px 8px 4px 4px;
  }

  .nextTurnAndUndo {
    display: flex;
    justify-content: center;
    margin-top: 10px;
    margin-bottom: 20px;
  }

  .v-simple-table-cell {
    height: 40px;
    font-size: 12pt;
  }

  .currentStatusTable {
    font-size: 12pt;
    margin-right: auto;
    margin-left: auto;
    padding-top: 16px;
  }

  .resultTable {
    font-size: 14pt;
  }

  svg {
    width: 500px;
    height: 400px;
  }
}
</style>
