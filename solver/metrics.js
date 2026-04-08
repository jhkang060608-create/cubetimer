export const metrics = {
  nodes: 0,
  reset() {
    this.nodes = 0;
  },
  increment() {
    this.nodes += 1;
  },
};
