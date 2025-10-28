-- CreateTable
CREATE TABLE `contacts_sectors` (
    `contactId` INTEGER NOT NULL,
    `sectorId` INTEGER NOT NULL,

    PRIMARY KEY (`contactId`, `sectorId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `contacts_sectors` ADD CONSTRAINT `contacts_sectors_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `contacts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contacts_sectors` ADD CONSTRAINT `contacts_sectors_sectorId_fkey` FOREIGN KEY (`sectorId`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
