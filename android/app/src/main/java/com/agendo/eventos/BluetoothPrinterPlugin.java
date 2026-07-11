package com.agendo.eventos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "BluetoothPrinter",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "bluetoothConnect"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "bluetoothScan"),
        @Permission(strings = { Manifest.permission.BLUETOOTH }, alias = "bluetooth"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_ADMIN }, alias = "bluetoothAdmin"),
    }
)
public class BluetoothPrinterPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private BluetoothSocket socket;
    private OutputStream outputStream;
    private PluginCall savedCall;

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_SCAN)
                == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    @PluginMethod
    public void list(PluginCall call) {
        if (!hasConnectPermission()) {
            savedCall = call;
            requestPermissionForAlias("bluetoothConnect", call, "bluetoothConnectCallback");
            return;
        }
        doList(call);
    }

    @PermissionCallback
    private void bluetoothConnectCallback(PluginCall call) {
        if (hasConnectPermission()) {
            doList(call);
        } else {
            call.reject("Permissão Bluetooth negada. Acesse Configurações > Apps > AGENDO Eventos > Permissões > Dispositivos próximos.");
        }
    }

    private void doList(PluginCall call) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth não disponível ou desativado");
            return;
        }
        Set<BluetoothDevice> paired = adapter.getBondedDevices();
        JSArray devices = new JSArray();
        for (BluetoothDevice device : paired) {
            JSObject d = new JSObject();
            d.put("name", device.getName());
            d.put("address", device.getAddress());
            devices.put(d);
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!hasConnectPermission()) {
            savedCall = call;
            requestPermissionForAlias("bluetoothConnect", call, "bluetoothConnectForConnectCallback");
            return;
        }
        doConnect(call);
    }

    @PermissionCallback
    private void bluetoothConnectForConnectCallback(PluginCall call) {
        if (hasConnectPermission()) {
            doConnect(call);
        } else {
            call.reject("Permissão Bluetooth negada.");
        }
    }

    private void doConnect(final PluginCall call) {
        final String address = call.getString("address");
        if (address == null) { call.reject("Endereço não informado"); return; }
        final BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) { call.reject("Bluetooth não disponível"); return; }

        // Roda fora da thread principal: connect() é bloqueante e faz retry com espera.
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (socket != null) { try { socket.close(); } catch (IOException ignored) {} socket = null; }
                    outputStream = null;
                    BluetoothDevice device = adapter.getRemoteDevice(address);

                    if (device.getBondState() != BluetoothDevice.BOND_BONDED) {
                        call.reject("A impressora não está pareada. Pareie ela no Bluetooth do celular e tente de novo.");
                        return;
                    }

                    IOException ultimoErro = null;
                    BluetoothSocket conectado = null;

                    for (int tentativa = 0; tentativa < 3 && conectado == null; tentativa++) {
                        if (tentativa > 0) { try { Thread.sleep(1500); } catch (InterruptedException ignored) {} }
                        if (hasScanPermission()) { try { adapter.cancelDiscovery(); } catch (Exception ignored) {} }

                        // Método 1: padrão (SPP UUID)
                        BluetoothSocket s = null;
                        try {
                            s = device.createRfcommSocketToServiceRecord(SPP_UUID);
                            s.connect();
                            conectado = s;
                            break;
                        } catch (IOException e1) {
                            ultimoErro = e1;
                            try { if (s != null) s.close(); } catch (IOException ignored) {}
                        }

                        // Método 2: reflection no canal 1
                        try {
                            Method m = device.getClass().getMethod("createRfcommSocket", new Class[]{ int.class });
                            s = (BluetoothSocket) m.invoke(device, 1);
                            s.connect();
                            conectado = s;
                            break;
                        } catch (Exception e2) {
                            if (e2 instanceof IOException) ultimoErro = (IOException) e2;
                            try { if (s != null) s.close(); } catch (Exception ignored) {}
                        }
                    }

                    if (conectado == null) {
                        call.reject("Não consegui conectar depois de 3 tentativas. Confira: 1) a impressora está LIGADA e por perto; 2) ela NÃO está conectada em outro app (feche o RawBT e o app da impressora); 3) se persistir, remova o pareamento e pareie de novo. Detalhe técnico: " + (ultimoErro != null ? ultimoErro.getMessage() : "sem resposta"));
                        return;
                    }

                    socket = conectado;
                    outputStream = socket.getOutputStream();
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Erro ao conectar: " + e.getMessage());
                }
            }
        }).start();
    }

    @PluginMethod
    public void write(PluginCall call) {
        String dataBase64 = call.getString("data");
        if (dataBase64 == null || outputStream == null) {
            call.reject("Sem conexão ou dados vazios");
            return;
        }
        final OutputStream out = outputStream;
        // Envia em blocos pequenos com pausa: impressoras baratas têm buffer pequeno e
        // "desligam"/reiniciam se receberem tudo de uma vez. A pausa dá tempo de imprimir.
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    byte[] bytes = android.util.Base64.decode(dataBase64, android.util.Base64.DEFAULT);
                    int bloco = 128;
                    for (int i = 0; i < bytes.length; i += bloco) {
                        int fim = Math.min(i + bloco, bytes.length);
                        out.write(bytes, i, fim - i);
                        out.flush();
                        try { Thread.sleep(30); } catch (InterruptedException ignored) {}
                    }
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Erro ao escrever: " + e.getMessage());
                }
            }
        }).start();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        try {
            if (outputStream != null) outputStream.close();
            if (socket != null) socket.close();
        } catch (IOException ignored) {}
        outputStream = null;
        socket = null;
        call.resolve();
    }
}