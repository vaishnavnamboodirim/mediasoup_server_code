const express = require("express");
const app = express();
const cors = require("cors");
const http = require("http");
const mediasoup = require("mediasoup");
const server = http.createServer(app);
const { config } = require("./config/index");

// app.use(cors());

const { Server } = require("socket.io");
const io = new Server(server);

let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;
setupMediasoup();

/* ***MEDIASOUP*** */
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2
  }
];
async function setupMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`Worker pid: ${worker.pid}`);
  worker.on("died", (error) => {
    console.error("Mediasoup worker has died :(");
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({ mediaCodecs });
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.emit("get:rtpCapabilities", {
    rtpCapabilities: router.rtpCapabilities,
  })

  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);
  });

  socket.on("request:rtpCapabilities", (data, callback) => {
    const rtpCapabilities = router.rtpCapabilities;
    callback({
      rtpCapabilities,
    });
  });

  socket.on("request:webRtcTransport", async ({ sender }, callback) => {
    if (sender) {
      producerTransport = await createWebRtcTransport(callback);
    } else {
      consumerTransport = await createWebRtcTransport(callback);
    }
  });

  socket.on('transportConnect', async ({ dtlsParameters }) => {
    console.log('DTLS PARAMS... ', { dtlsParameters })
    await producerTransport.connect({ dtlsParameters })
  })

  socket.on('transportProduce', async ({ kind, rtpParameters, appData }, callback) => {
    // call produce based on the prameters from the client
    producer = await producerTransport.produce({
      kind,
      rtpParameters,
    })

    console.log('Producer ID: ', producer.id, producer.kind)

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })

    // Send back to the client the Producer's id
    callback({
      id: producer.id
    })
  })

  socket.on('transportRecvConnect', async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters} hey `)
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      // check if the router can consume the specified producer
      if (router.canConsume({
        producerId: producer.id,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
        })

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })

  socket.on('consumerResume', async () => {
    console.log('consumer resume')
    await consumer.resume()
  })
});

server.listen(config.port, function () {
  console.log(`Listening http://localhost:${config.port}`);
});

const createWebRtcTransport = async (callback) => {
  try {
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: "127.0.0.1",
          // announcedIp: "127.0.0.1",
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    };

    let transport = await router.createWebRtcTransport(webRtcTransport_options);
    console.log(`transport id: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("close", () => {
      console.log("transport closed");
    });

    // send back to the client the following prameters
    callback({
      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });

    return transport;
  } catch (error) {
    console.log(error);
    callback({
      params: {
        error,
      },
    });
  }
};
