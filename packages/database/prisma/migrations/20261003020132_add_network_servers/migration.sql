-- CreateTable
CREATE TABLE "network_servers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "passwordHint" TEXT NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "lastTestLatencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" "NetworkMode" NOT NULL DEFAULT 'DIRECT',
    "activeServerId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_state_pkey" PRIMARY KEY ("id")
);
