package com.praha.stream;

import android.content.Intent;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A DNS-only VPN.
 *
 * Sources in this app are blocked at the resolver, not on the wire, so the thing
 * a "VPN" toggle has to beat is DNS filtering. Routing every byte through a free
 * VPN endpoint would make streaming slower and hand the user's traffic to an
 * anonymous volunteer; capturing only DNS and relaying it to a resolver of the
 * user's choosing fixes the actual block without that cost. Media and torrent
 * traffic keeps using the normal interface.
 *
 * This is a real VpnService: Android shows its key icon and the user grants
 * consent once. Nothing here is hidden from them. It deliberately does not run
 * a foreground service — the VPN framework already owns the process lifetime,
 * and a notification is not what keeps a tun interface open.
 */
public final class PrahaDnsVpnService extends VpnService {
    private static final String TAG = "PrahaDnsVpn";

    /** The address the tunnel hands the OS to send DNS queries to. */
    private static final String TUN_DNS = "10.111.222.2";
    private static final String TUN_ADDRESS = "10.111.222.1";

    public static final String ACTION_START = "com.praha.stream.DNS_VPN_START";
    public static final String ACTION_STOP = "com.praha.stream.DNS_VPN_STOP";
    public static final String EXTRA_DNS = "dns_server";

    private static final AtomicBoolean running = new AtomicBoolean(false);
    /** True while a live tunnel exists; the bridge reports this to the UI. */
    private static volatile boolean active = false;

    private ParcelFileDescriptor tunnel;
    private Thread reader;
    /** One short task per query, so a slow lookup cannot stall the rest. */
    private ExecutorService pool;
    /** Resolver the live tunnel was built with, so a change can restart it. */
    private volatile String currentDns;

    public static boolean isActive() {
        return active;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopTunnel();
            stopSelf();
            return START_NOT_STICKY;
        }
        String dns = intent == null ? null : intent.getStringExtra(EXTRA_DNS);
        if (dns == null || dns.isEmpty()) dns = "1.1.1.1";
        // Restart in place when the resolver changed: sending a separate STOP
        // and START would race, and the STOP could tear down the new tunnel.
        if (running.get() && !dns.equals(currentDns)) stopTunnel();
        startTunnel(dns);
        return START_NOT_STICKY;
    }

    private void startTunnel(String dnsServer) {
        if (running.get()) return;
        try {
            Builder builder = new Builder()
                    .setSession("PRAHA DNS filter")
                    .setMtu(1500)
                    // Only the DNS address is routed into the tunnel, so media
                    // traffic never becomes a bottleneck.
                    .addAddress(TUN_ADDRESS, 24)
                    .addDnsServer(TUN_DNS)
                    .addRoute(TUN_DNS, 32);

            // Never capture ourselves: PRAHA resolves its own DNS outside the
            // tunnel, which also stops loopback queries from recursing.
            try {
                builder.addDisallowedApplication(getPackageName());
            } catch (Exception ignored) {
                // Older releases: loopback DNS still resolves fine.
            }

            tunnel = builder.establish();
            if (tunnel == null) {
                // Consent was refused or revoked between prepare() and here.
                stopSelf();
                return;
            }

            running.set(true);
            active = true;
            currentDns = dnsServer;
            pool = Executors.newFixedThreadPool(4);
            reader = new Thread(() -> readLoop(tunnel, dnsServer), "praha-dns-vpn");
            reader.start();
        } catch (Exception error) {
            Log.w(TAG, "Unable to start DNS tunnel", error);
            stopTunnel();
            stopSelf();
        }
    }

    /** Blocking read loop over the tun device. */
    private void readLoop(ParcelFileDescriptor descriptor, String dnsServer) {
        FileInputStream in = new FileInputStream(descriptor.getFileDescriptor());
        FileOutputStream out = new FileOutputStream(descriptor.getFileDescriptor());
        byte[] buffer = new byte[32767];
        while (running.get()) {
            try {
                int length = in.read(buffer);
                if (length <= 0) {
                    if (!running.get()) break;
                    continue;
                }
                byte[] packet = new byte[length];
                System.arraycopy(buffer, 0, packet, 0, length);
                ExecutorService executor = pool;
                if (executor == null) break;
                executor.execute(() -> {
                    byte[] reply = answer(packet, dnsServer);
                    if (reply == null) return;
                    synchronized (out) {
                        try { out.write(reply); } catch (IOException ignored) { }
                    }
                });
            } catch (IOException error) {
                // Closing the descriptor during shutdown lands here; that is normal.
                if (running.get()) Log.w(TAG, "DNS tunnel read failed", error);
                break;
            }
        }
    }

    /**
     * Extracts the DNS payload from a raw IPv4/UDP packet, asks the resolver,
     * and rebuilds a reply with addresses and ports swapped.
     */
    private byte[] answer(byte[] packet, String dnsServer) {
        try {
            if (packet.length < 28) return null;
            int version = (packet[0] >> 4) & 0x0F;
            if (version != 4) return null;
            int ihl = (packet[0] & 0x0F) * 4;
            if (ihl < 20 || packet.length < ihl + 8) return null;
            if ((packet[9] & 0xFF) != 17) return null; // UDP only

            int srcPort = ((packet[ihl] & 0xFF) << 8) | (packet[ihl + 1] & 0xFF);
            int dstPort = ((packet[ihl + 2] & 0xFF) << 8) | (packet[ihl + 3] & 0xFF);
            if (dstPort != 53) return null;

            int dnsOffset = ihl + 8;
            int dnsLength = packet.length - dnsOffset;
            if (dnsLength <= 0) return null;
            byte[] query = new byte[dnsLength];
            System.arraycopy(packet, dnsOffset, query, 0, dnsLength);

            byte[] resolved = queryResolver(query, dnsServer);
            if (resolved == null) return null;

            int udpLength = 8 + resolved.length;
            int totalLength = ihl + udpLength;
            byte[] reply = new byte[totalLength];
            System.arraycopy(packet, 0, reply, 0, ihl);

            reply[2] = (byte) (totalLength >> 8);
            reply[3] = (byte) totalLength;
            reply[8] = 64;                 // TTL
            reply[9] = 17;                 // protocol: UDP

            // Swap source and destination IPv4 addresses.
            System.arraycopy(packet, 16, reply, 12, 4);
            System.arraycopy(packet, 12, reply, 16, 4);

            // Swap ports: the reply comes from the port that was queried.
            reply[ihl] = (byte) (dstPort >> 8);
            reply[ihl + 1] = (byte) dstPort;
            reply[ihl + 2] = (byte) (srcPort >> 8);
            reply[ihl + 3] = (byte) srcPort;

            reply[ihl + 4] = (byte) (udpLength >> 8);
            reply[ihl + 5] = (byte) udpLength;
            // A zero UDP checksum means "not computed", which is legal on IPv4
            // and avoids a whole class of pseudo-header mistakes.
            reply[ihl + 6] = 0;
            reply[ihl + 7] = 0;

            System.arraycopy(resolved, 0, reply, ihl + 8, resolved.length);

            reply[10] = 0;
            reply[11] = 0;
            int headerChecksum = headerChecksum(reply, ihl);
            reply[10] = (byte) (headerChecksum >> 8);
            reply[11] = (byte) headerChecksum;
            return reply;
        } catch (Exception error) {
            return null;
        }
    }

    /** IPv4 header checksum over the first `ihl` bytes. */
    private static int headerChecksum(byte[] data, int ihl) {
        long sum = 0;
        for (int i = 0; i + 1 < ihl; i += 2) {
            sum += ((data[i] & 0xFF) << 8) | (data[i + 1] & 0xFF);
        }
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        return (int) (~sum & 0xFFFF);
    }

    /** Asks the configured resolver over UDP, out of the real interface. */
    private byte[] queryResolver(byte[] query, String dnsServer) {
        try (DatagramSocket socket = new DatagramSocket()) {
            // protect() keeps this socket off the tunnel, so DNS cannot recurse.
            protect(socket);
            socket.setSoTimeout(5000);
            InetAddress address = InetAddress.getByName(dnsServer);
            socket.send(new DatagramPacket(query, query.length, address, 53));
            byte[] buffer = new byte[4096];
            DatagramPacket response = new DatagramPacket(buffer, buffer.length);
            socket.receive(response);
            byte[] result = new byte[response.getLength()];
            System.arraycopy(buffer, 0, result, 0, result.length);
            return result;
        } catch (Exception error) {
            return null;
        }
    }

    private void stopTunnel() {
        running.set(false);
        active = false;
        ExecutorService executor = pool;
        pool = null;
        if (executor != null) executor.shutdownNow();
        Thread current = reader;
        reader = null;
        if (current != null) current.interrupt();
        if (tunnel != null) {
            try { tunnel.close(); } catch (IOException ignored) { }
            tunnel = null;
        }
    }

    @Override public void onDestroy() {
        stopTunnel();
        super.onDestroy();
    }
}
