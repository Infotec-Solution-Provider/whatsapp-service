-- CreateTable
CREATE TABLE `parameters` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `scope` ENUM('INSTANCE', 'SECTOR', 'USER') NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NULL,
    `sectorId` INTEGER NULL,
    `userId` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
