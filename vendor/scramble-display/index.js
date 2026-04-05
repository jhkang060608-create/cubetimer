// src/scramble-display/ScrambleDisplay.ts
import { Alg } from "cubing/alg";
import { eventInfo } from "cubing/puzzles";
import { TwistyPlayer } from "cubing/twisty";

// src/scramble-display/css.ts
var mainStyleText = `
:host {
  width: 384px;
  height: 256px;
  display: grid;
}

.wrapper {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
  place-content: center;
  overflow: hidden;
}

.wrapper > * {
  width: inherit;
  height: inherit;
  overflow: hidden;
}

twisty-player {
  width: 100%;
  height: 100%;
}
`;

// src/scramble-display/ScrambleDisplay.ts
var CUBE_333 = "333";
var DEFAULT_EVENT = CUBE_333;
var ScrambleDisplay = class extends HTMLElement {
  #shadow;
  #wrapper = document.createElement("div");
  #currentAttributes = {
    eventID: null,
    scramble: new Alg(),
    visualization: null,
    checkered: false
  };
  #twistyPlayer = new TwistyPlayer({
    controlPanel: "none",
    hintFacelets: "none",
    visualization: "2D",
    background: "none"
  });
  // Note: You should avoid setting properties like `alg` or `visualization`
  // directly on the twisty player, since `<scramble-display>` may overwrite
  // them again. However, we make the player available this way in case you may
  // find it convenient to have access for other purposes.
  get player() {
    return this.#twistyPlayer;
  }
  // TODO: Accept ScrambleDisplayAttributes arg?
  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "closed" });
    this.#wrapper.classList.add("wrapper");
    this.#shadow.appendChild(this.#wrapper);
    const style = document.createElement("style");
    style.textContent = mainStyleText;
    this.#shadow.appendChild(style);
  }
  connectedCallback() {
    this.#wrapper.appendChild(this.#twistyPlayer);
  }
  set event(eventID) {
    const info = eventInfo(eventID ?? DEFAULT_EVENT);
    this.#twistyPlayer.puzzle = info?.puzzleID ?? "3x3x3";
    this.#currentAttributes.eventID = eventID;
  }
  get event() {
    return this.#currentAttributes.eventID;
  }
  set scramble(scramble) {
    const alg = new Alg(scramble ?? "");
    this.#twistyPlayer.alg = alg;
    this.#currentAttributes.scramble = alg;
    this.#wrapper.setAttribute("title", alg.toString());
  }
  get scramble() {
    return this.#currentAttributes.scramble;
  }
  set visualization(visualization) {
    this.#twistyPlayer.visualization = visualization ?? "2D";
    this.#currentAttributes.visualization = visualization;
  }
  get visualization() {
    return this.#currentAttributes.visualization;
  }
  set checkered(checkered) {
    const checkeredBoolean = !!checkered;
    this.#twistyPlayer.background = checkeredBoolean ? "checkered" : "none";
    this.#currentAttributes.checkered = checkeredBoolean;
  }
  get checkered() {
    return this.#currentAttributes.checkered;
  }
  attributeChangedCallback(name, _oldValue, newValue) {
    switch (name) {
      case "event": {
        this.event = newValue;
        break;
      }
      case "scramble": {
        this.scramble = newValue;
        break;
      }
      case "visualization": {
        this.visualization = newValue;
        break;
      }
      case "checkered": {
        this.checkered = newValue !== null;
        break;
      }
    }
  }
  static get observedAttributes() {
    return ["event", "scramble", "visualization", "checkered"];
  }
};
customElements.define("scramble-display", ScrambleDisplay);
export {
  ScrambleDisplay
};
//# sourceMappingURL=index.js.map
