export class VoucherStore {
  #states = new Map();

  constructor(ids = []) {
    for (const id of ids) this.#states.set(id, "available");
  }

  state(id) {
    return this.#states.get(id) ?? "missing";
  }

  reserve(id) {
    if (this.state(id) !== "available") return false;
    this.#states.set(id, "reserved");
    return true;
  }

  spend(id) {
    this.#settle(id, "spent");
  }

  markUncertain(id) {
    this.#settle(id, "uncertain");
  }

  release(id) {
    this.#settle(id, "available");
  }

  #settle(id, next) {
    if (this.state(id) !== "reserved") throw new Error(`voucher ${id} is not reserved`);
    this.#states.set(id, next);
  }
}
