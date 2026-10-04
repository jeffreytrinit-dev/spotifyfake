/*
  Warnings:

  - Added the required column `sourceHash` to the `TranscodeCache` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TranscodeCache" ADD COLUMN     "sourceHash" TEXT NOT NULL;
