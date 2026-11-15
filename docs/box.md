# Running a MeshSites box

A box is any computer on a Wi-Fi network that hands MeshSites sites to ordinary browsers. Visitors join the Wi-Fi and open a page. They need no app and no internet.

**Status: the server is tested in software only (`npm test`, plus a browser on the same computer). Nobody has run it on a router or a Raspberry Pi yet. The hardware recipes below are the intended setup, not a verified one. If you try one, please report what happened.**

## What visitors are trusting

The box checks every site (each block against its hash, the whole tree, the size limits) and every name's signature before it serves anything. A browser on plain HTTP can't repeat those checks, so a visitor is trusting whoever runs the box. Say so where you advertise the box. People with the MeshSites app can download the same files from the box and check them on their own phone.

## 1. Try it on one computer

Needs Node 22.18 or newer.

```sh
npm install
node cli/src/main.ts serve examples
```

Open `http://localhost:8080/`. The two example sites are listed. Any phone on the same Wi-Fi can open `http://<this computer's IP>:8080/` (the command prints the address).

## 2. The box folder

`serve` takes one folder. Put in it:

| File | What |
|---|---|
| `*.car` | sites, as made by `meshsites publish`. A file that fails verification is refused and reported at start. |
| `*.json` signed records | optional. The `…record.signed.json` that `publish` writes, or the value of a name's `meshsites.record` ENS text record saved to a file. |
| `signers.json` | optional. Which address may sign for a name: `{"yourname.eth": "0x…"}`. Copy it from the name's `meshsites.signer` ENS text record while you have internet. |

Files can be added or removed while the box runs.

Sites over 1 MiB (up to 64 MiB) are allowed on a box: package them with `publish --box`. They are marked "Wi-Fi only", because phones won't pass them on over Bluetooth.

## 3. Names without internet

A box never looks a name up. It reads the name's **signed record** from the folder: a small file that says "`yourname.eth` is this site" and is signed by the name's delegate key.

- With the name in `signers.json`, only a record signed by that address is accepted, and the list shows **Name verified**.
- Without it, a correctly signed record is still served, marked **Name not checked against ENS**. If two different keys both claim the name, it isn't served at all.
- The newest record (highest `seq`) whose site is in the folder wins.

So the one step that needs internet is done once, by the operator: copy the name's two text records. After that the name works offline, and an update can arrive by USB stick or from a phone.

## 4. Making `mesh.lan` and `name.eth` work: DNS

By IP address everything works, but all sites share one address (`http://192.168.8.2:8080/ipfs/<cid>/`). With DNS pointed at the box:

- each site gets its own address (`http://<cid>.mesh.lan/`, `http://yourname.eth.mesh.lan/`), which keeps one site's scripts and storage away from another's,
- people can type `http://yourname.eth/` (with the `http://`, or a trailing `/`, so the browser doesn't search instead),
- phones show their "sign in to Wi-Fi" sheet with the list of sites as soon as they join.

The network's DNS has to answer **every** name with the box's address. Two ways:

**The box answers DNS itself** (works with an ordinary home router):

```sh
sudo node cli/src/main.ts serve ./box --port 80 --dns 192.168.8.2   # this computer's address
```

Then, in the router's settings, set the DNS server it hands out (often under DHCP or LAN) to that same address, and give the computer a fixed address so it doesn't change.

**The router answers DNS** (OpenWrt, GL.iNet and others that run dnsmasq): add `address=/#/192.168.8.2` to the dnsmasq settings and run `serve` without `--dns`.

## 5. Hardware

In every case: the router has **no internet cable** plugged in, the computer has a fixed address, and `serve` runs on port 80.

- **Spare home router + laptop.** Join the laptop to the router. Use `--dns` as above and set the router's DHCP DNS server to the laptop.
- **Travel router (GL.iNet or other OpenWrt) + laptop.** Same, or use the router's dnsmasq (`address=/#/<laptop address>`). The router doesn't need to run anything.
- **Raspberry Pi alone.** Make it an access point (on Raspberry Pi OS: `sudo nmcli device wifi hotspot ssid MeshSites password <8+ characters>`), then run `serve` with `--dns <the Pi's hotspot address>`. NetworkManager's hotspot runs its own DNS on port 53; that has to be turned off or pointed at the box first.

## What to check when testing

1. A phone joins the Wi-Fi with mobile data off. Does a sign-in sheet appear with the list?
2. Does a site open from the list? Do its pages, images and links work?
3. Does `http://meshsites.eth/` open from the address bar?
4. Does the phone stay on the Wi-Fi? (Phones tend to leave networks with no internet; "Use without internet" or "Stay connected" is the usual prompt.)
5. A site over 1 MiB with a video: does it play and seek?

## What a box serves

| Address | What |
|---|---|
| `http://mesh.lan/` | the list of sites |
| `http://<cid>.mesh.lan/` | one site |
| `http://<name>.eth/`, `http://<name>.eth.mesh.lan/` | the site a signed record names |
| `/ipfs/<cid>/`, `/ipns/<name>/` | the same sites by IP address, when there is no box DNS |
| `/sites.json` | the list, for programs |
| `/car/<cid>.car` | the site's CAR, unchanged |
| `/record/<name>.json` | the name's signed record, unchanged |
| any other host name | redirect to `http://mesh.lan/` |

`--domain` changes `mesh.lan`. Only `GET` and `HEAD` are answered. Site pages get a Content-Security-Policy that lets them load only their own files.

## Limits

- Plain HTTP only. A box can't get a certificate browsers accept while offline, so browser features that need HTTPS (service workers, camera, clipboard) don't work in sites served this way.
- A browser that insists on HTTPS or on its own DNS (DNS over HTTPS, iCloud Private Relay, some VPNs) won't reach `name.eth` addresses; the list at the box's IP address still works.
- No online fetching yet: the operator copies CARs and records into the folder by hand.
