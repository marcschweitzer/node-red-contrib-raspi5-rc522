/**
 * node-red-contrib-raspi5-rc522
 * Node: raspi5-rc522
 *
 * Modes:
 * - uid  : output UID on card change (auto polling)
 * - read : on card change OR input trigger -> auth+read block
 * - write: on card change OR input trigger -> auth+write block, optional verify
 *
 * Overrides via msg:
 * - msg.block, msg.keyA, msg.data (hex string), msg.action ("uid"|"read"|"write")
 *
 * Presence events (Option 3):
 * - When enabled, node emits:
 *   - topic: "present" when a card is detected (first time / changed)
 *   - topic: "removed" when the previously present card disappears
 */
module.exports = function(RED) {
  const { MFRC522, ensure16Bytes } = require("./lib/mfrc522");

  function parseIntSafe(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  function normalizeHexKey(keyA) {
    const s = String(keyA || "").trim();
    return s.length ? s : "FFFFFFFFFFFF";
  }

  function normalizeHexData(data) {
    const s = String(data || "").trim();
    return s.length ? s : "00000000000000000000000000000000";
  }

  function Rc522Node(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Config
    const bus = parseIntSafe(config.bus, 1);
    const dev = parseIntSafe(config.dev, 0);
    const speedHz = parseIntSafe(config.speedHz, 1_000_000);

    const mode = String(config.mode || "uid"); // uid|read|write
    const auto = !!config.auto;
    const pollMs = Math.max(80, parseIntSafe(config.pollMs, 250));

    const blockCfg = parseIntSafe(config.block, 8);
    const keyACfg = normalizeHexKey(config.keyA);
    const dataCfg = normalizeHexData(config.data);
    const verify = !!config.verify;

    // Presence events
    const emitRemoved = (config.emitRemoved === undefined) ? true : !!config.emitRemoved;
    const removedMs = Math.max(100, parseIntSafe(config.removedMs, 500));

    let reader = null;
    let timer = null;

    let presentUid = null;    // currently "present" card UID (4-byte CL1 UID in hex)
    let presentSak = null;
    let presentAtqa = null;
    let lastSeenTs = 0;       // last time we saw *any* card (ATQA) and could read UID
    let busy = false;

    function setStatus(fill, shape, text) {
      node.status({ fill, shape, text });
    }

    async function ensureReader() {
      if (reader) return;
      reader = new MFRC522({ bus, device: dev, speedHz });
      reader.open();
      await reader.init();
      setStatus("green", "dot", `ready spidev${bus}.${dev}`);
    }

    async function doSelect(uid) {
      const sel = await reader.selectCL1(uid);
      return sel ? sel.sak : null;
    }

    function buildMsgBase(uidHex, sak, atqaHex) {
      return {
        payload: {
          uid: uidHex,
          sak: sak != null ? ("0x" + sak.toString(16).padStart(2,"0")) : null,
          atqa: atqaHex || null,
          bus, dev,
          ts: Date.now()
        }
      };
    }

    function emitRemovedEvent(reason) {
      if (!emitRemoved) return;
      if (!presentUid) return;
      const msg = buildMsgBase(presentUid, presentSak, presentAtqa);
      msg.topic = "removed";
      msg.payload.event = "removed";
      msg.payload.reason = reason || "timeout";
      node.send(msg);
      setStatus("grey", "ring", `removed ${presentUid}`);
      presentUid = null;
      presentSak = null;
      presentAtqa = null;
    }

    function emitPresentEvent(uidHex, sak, atqaHex, reason) {
      const msg = buildMsgBase(uidHex, sak, atqaHex);
      msg.topic = "present";
      msg.payload.event = "present";
      msg.payload.reason = reason || "detected";
      node.send(msg);
      setStatus("blue", "dot", `present ${uidHex}`);
    }

    async function handleCard(action, overrides = {}) {
      if (busy) return;
      busy = true;

      try {
        await ensureReader();

        const now = Date.now();
        const atqa = await reader.requestA();

        // No card detected: check removal timeout
        if (!atqa) {
          if (presentUid && (now - lastSeenTs) >= removedMs) {
            emitRemovedEvent("no_card");
          }
          if (!presentUid) setStatus("grey", "ring", "no card");
          return;
        }

        const uid = await reader.anticollCL1();
        if (!uid) return;

        const uidHex = MFRC522.uidToHex(uid);
        const sak = await doSelect(uid);
        const atqaHex = atqa.toString("hex");
        lastSeenTs = now;

        // If a different card appears without removal, emit removed first (optional) then present
        if (presentUid && uidHex !== presentUid) {
          emitRemovedEvent("changed");
        }

        const useAction = String(overrides.action || action || mode);
        const useBlock = parseIntSafe(overrides.block, blockCfg);
        const useKeyA = normalizeHexKey(overrides.keyA || keyACfg);
        const useData = normalizeHexData(overrides.data || dataCfg);

        const isTriggered = !!overrides.triggered;

        // Presence event: only when newly detected or changed (and not on every poll)
        if (!presentUid || uidHex !== presentUid) {
          presentUid = uidHex;
          presentSak = sak;
          presentAtqa = atqaHex;
          emitPresentEvent(uidHex, sak, atqaHex, presentUid ? "detected" : "detected");
        }

        // If we're in UID mode and auto polling, we don't need to emit a second message besides present.
        // For backward compatibility / trigger usage:
        if (useAction === "uid") {
          if (isTriggered) {
            const msg = buildMsgBase(uidHex, sak, atqaHex);
            msg.topic = "uid";
            node.send(msg);
            setStatus("blue", "dot", `uid ${uidHex}`);
          }
          return;
        }

        // Safety: refuse risky blocks for write
        if (useAction === "write" && (useBlock === 0 || MFRC522.isTrailerBlock(useBlock))) {
          setStatus("red", "ring", `refused block ${useBlock}`);
          node.error(`Refused to write block ${useBlock} (block 0 or trailer).`, {});
          return;
        }

        // In auto mode, only run READ/WRITE once per "present" card unless triggered.
        if (!isTriggered && presentUid === uidHex && (useAction === "read" || useAction === "write")) {
          // Allow once: we mark by setting a flag on payload? easiest: keep lastActionUid+action+block
        }

        // AUTH for read/write
        await reader.mifareAuthKeyA(useBlock, useKeyA, uid);

        if (useAction === "read") {
          const data16 = await reader.mifareReadBlock(useBlock);
          const msg = buildMsgBase(uidHex, sak, atqaHex);
          msg.topic = "read";
          msg.payload.event = "read";
          msg.payload.block = useBlock;
          msg.payload.data = data16.toString("hex");
          node.send(msg);
          setStatus("green", "dot", `read b${useBlock}`);
          return;
        }

        if (useAction === "write") {
          const data16 = ensure16Bytes(useData);
          await reader.mifareWriteBlock(useBlock, data16);

          let verified = null;
          let readBackHex = null;
          if (verify) {
            await reader.mifareAuthKeyA(useBlock, useKeyA, uid);
            const after = await reader.mifareReadBlock(useBlock);
            readBackHex = after.toString("hex");
            verified = (readBackHex === data16.toString("hex"));
          }

          const msg = buildMsgBase(uidHex, sak, atqaHex);
          msg.topic = "write";
          msg.payload.event = "write";
          msg.payload.block = useBlock;
          msg.payload.data = data16.toString("hex");
          if (verify) {
            msg.payload.readBack = readBackHex;
            msg.payload.verified = verified;
          }
          node.send(msg);
          setStatus("yellow", "dot", `write b${useBlock}`);
          return;
        }
      } catch (e) {
        setStatus("red", "ring", e.message || "error");
        node.error(e, {});
      } finally {
        busy = false;
      }
    }

    async function pollLoop() {
      await handleCard(mode, {});
    }

    // Input trigger support
    node.on("input", async function(msg, send, done) {
      try {
        const action = msg.action || (msg.payload && msg.payload.action) || msg.topic;
        const overrides = {
          triggered: true,
          action: action || mode,
          block: msg.block ?? (msg.payload && msg.payload.block),
          keyA: msg.keyA ?? (msg.payload && msg.payload.keyA),
          data: msg.data ?? (msg.payload && msg.payload.data),
        };
        await handleCard(overrides.action, overrides);
        done();
      } catch (e) {
        node.error(e, msg);
        done(e);
      }
    });

    node.on("close", function(removed, done) {
      try {
        if (timer) clearInterval(timer);
        timer = null;
        if (reader) reader.close();
        reader = null;
        done();
      } catch (e) {
        done();
      }
    });

    // Start
    (async () => {
      try {
        await ensureReader();
        lastSeenTs = Date.now();
        if (auto) {
          timer = setInterval(() => { pollLoop(); }, pollMs);
          setStatus("green", "dot", `poll ${pollMs}ms`);
        } else {
          setStatus("green", "ring", "waiting trigger");
        }
      } catch (e) {
        setStatus("red", "ring", e.message || "init error");
        node.error(e, {});
      }
    })();
  }

  RED.nodes.registerType("raspi5-rc522", Rc522Node);
};
