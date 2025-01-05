"use client";

import { useEffect, useRef, useState } from "react";

const signalingServerUrl = "ws://localhost:8080/ws";

const WebrtcPage = () => {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  useEffect(() => {
    connectToSignalingServer();
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, []);

  const connectToSignalingServer = () => {
    const socket = new WebSocket(signalingServerUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("Connected to signaling server");
      setConnected(true);
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      console.log("Received message:", message);

      try {
        switch (message.type) {
          case "offer":
            await handleOffer(message.sdp);
            break;
          case "answer":
            await handleAnswer(message.sdp);
            break;
          case "ice_candidate":
            if (message.candidate) {
              await handleICECandidate(message.candidate);
            }
            break;
        }
      } catch (error) {
        console.error("Error handling message:", error);
      }
    };

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      setMessages((prev) => [...prev, `Error: ${error.toString()}`]);
    };

    socket.onclose = () => {
      console.log("Disconnected from signaling server");
      setConnected(false);
    };
  };

  const setupPeerConnection = () => {
    const config = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };

    const pc = new RTCPeerConnection(config);
    peerConnectionRef.current = pc;

    // Create data channel
    const dataChannel = pc.createDataChannel("fileTransfer", {
      ordered: true,
    });
    dataChannelRef.current = dataChannel;

    setupDataChannelHandlers(dataChannel);

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        const message = {
          type: "ice_candidate",
          candidate: event.candidate.toJSON(),
        };
        socketRef.current.send(JSON.stringify(message));
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      dataChannelRef.current = channel;
      setupDataChannelHandlers(channel);
    };

    return pc;
  };

  const setupDataChannelHandlers = (channel: RTCDataChannel) => {
    channel.onopen = () => {
      console.log("Data channel opened");
      setMessages((prev) => [...prev, "Data channel opened"]);
    };

    channel.onmessage = (event) => {
      console.log("Received data:", event.data);
      setMessages((prev) => [...prev, `Received: ${event.data}`]);
    };

    channel.onerror = (error) => {
      console.error("Data channel error:", error);
      setMessages((prev) => [
        ...prev,
        `Data channel error: ${error.toString()}`,
      ]);
    };

    channel.onclose = () => {
      console.log("Data channel closed");
      setMessages((prev) => [...prev, "Data channel closed"]);
    };
  };

  const createOffer = async () => {
    const pc = setupPeerConnection();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (socketRef.current) {
        socketRef.current.send(
          JSON.stringify({
            type: "offer",
            sdp: offer.sdp,
          })
        );
      }
    } catch (error) {
      console.error("Error creating offer:", error);
      setMessages((prev) => [...prev, `Error creating offer: ${error}`]);
    }
  };

  const handleOffer = async (sdp: string) => {
    const pc = setupPeerConnection();

    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription({
          type: "offer",
          sdp,
        })
      );

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (socketRef.current) {
        socketRef.current.send(
          JSON.stringify({
            type: "answer",
            sdp: answer.sdp,
          })
        );
      }
    } catch (error) {
      console.error("Error handling offer:", error);
      setMessages((prev) => [...prev, `Error handling offer: ${error}`]);
    }
  };

  const handleAnswer = async (sdp: string) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp })
        );
      }
    } catch (error) {
      console.error("Error handling answer:", error);
      setMessages((prev) => [...prev, `Error handling answer: ${error}`]);
    }
  };

  const handleICECandidate = async (candidate: RTCIceCandidateInit) => {
    try {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      }
    } catch (error) {
      console.error("Error handling ICE candidate:", error);
      setMessages((prev) => [
        ...prev,
        `Error handling ICE candidate: ${error}`,
      ]);
    }
  };

  const sendMessage = () => {
    if (dataChannelRef.current?.readyState === "open") {
      const message = "Hello from peer!";
      dataChannelRef.current.send(message);
      setMessages((prev) => [...prev, `Sent: ${message}`]);
    } else {
      setMessages((prev) => [...prev, "Data channel not open"]);
    }
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">WebRTC P2P Connection</h1>
      <div className="space-y-4">
        <div className="flex space-x-4">
          <button
            className="px-4 py-2 bg-blue-500 text-white rounded disabled:bg-gray-400"
            onClick={createOffer}
            disabled={!connected}
          >
            Create Connection
          </button>
          <button
            className="px-4 py-2 bg-green-500 text-white rounded disabled:bg-gray-400"
            onClick={sendMessage}
            disabled={
              !dataChannelRef.current ||
              dataChannelRef.current.readyState !== "open"
            }
          >
            Send Test Message
          </button>
        </div>

        <div className="border rounded p-4 min-h-[200px] bg-gray-50">
          <h2 className="font-semibold mb-2">Connection Status:</h2>
          <p>{connected ? "Connected to signaling server" : "Disconnected"}</p>
          <p>
            Data Channel: {dataChannelRef.current?.readyState || "not created"}
          </p>
        </div>

        <div className="border rounded p-4 max-h-[300px] overflow-y-auto">
          <h2 className="font-semibold mb-2">Messages:</h2>
          {messages.map((msg, index) => (
            <div key={index} className="py-1">
              {msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WebrtcPage;
