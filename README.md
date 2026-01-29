# node-red-contrib-raspi5-rc522

RC522 / MFRC522 RFID Node for **Raspberry Pi 5** – **pure JavaScript**, no Python, no external daemon.

Supports:
- SPI0 **and** SPI1 (bus/device selectable)
- UID / READ / WRITE (MIFARE Classic)
- Auto polling or trigger-by-message
- Presence events: `present` / `removed`
- Dynamic wiring hints in the Node-RED editor

---

## ⚠️ Prerequisite: SPI must be enabled

This node talks **directly** to `/dev/spidev*`.  
If SPI is not enabled, the node **cannot work**.

### Enable SPI0 (standard)

```bash
sudo raspi-config
```
→ *Interface Options* → *SPI* → **Enable**

Reboot, then check:
```bash
ls -l /dev/spidev*
```
You should see at least:
```
/dev/spidev0.0
```

---

### Enable SPI1 (second SPI controller)

SPI1 is **not enabled by default**.

Edit:
```bash
sudo nano /boot/firmware/config.txt
```

Add **one** of the following lines (example with 3 chip-selects):
```
dtoverlay=spi1-3cs
```

Reboot.

Verify:
```bash
ls -l /dev/spidev*
```
Expected:
```
/dev/spidev1.0
/dev/spidev1.1
/dev/spidev1.2   (depending on overlay)
```

If `/dev/spidev1.0` does not exist → SPI1 is **not active**.

---

## Wiring

The node editor shows **dynamic wiring instructions** depending on SPI0/SPI1 selection.

Typical RC522 pins:
- 3.3V (⚠️ never 5V)
- GND
- SCK
- MOSI
- MISO
- SDA / SS → chip select (CS)
- RST (optional)

---

## Installation

### Via Node-RED Palette
Search for:
```
node-red-contrib-raspi5-rc522
```

### Manual install
```bash
cd ~/.node-red
npm install node-red-contrib-raspi5-rc522
sudo systemctl restart nodered
```

---

## Node Configuration

Configured **entirely inside the node**:

- SPI Bus (0 or 1)
- Device / CS (0–2)
- Mode:
  - `UID`
  - `READ`
  - `WRITE`
- Auto poll + interval
- Block, Key A, Data, Verify
- Presence events (`present` / `removed`)
- Removed timeout (ms)

---

## Output Events

### Card detected
```
topic: "present"
payload.event: "present"
```

### Card removed
```
topic: "removed"
payload.event: "removed"
```

### Read
```
topic: "read"
payload.data: "<hex>"
```

### Write
```
topic: "write"
payload.verified: true|false
```

---

## Safety

To avoid destroying cards:
- ❌ Block 0 write disabled
- ❌ Trailer block write disabled (3,7,11,…)

---

## Test / Debug

Check permissions:
```bash
groups
# user must be in group: spi
```

Add user if needed:
```bash
sudo usermod -aG spi $USER
```

Re-login required.

---

## License
MIT
