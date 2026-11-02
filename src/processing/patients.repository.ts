import { Inject, Injectable } from '@nestjs/common';
import { Collection, Db, MongoServerError } from 'mongodb';
import { emptyPatientState, PatientState } from '../domain';
import { MONGO_DB } from '../database/database.module';
import { PatientDocument } from './patient.document';

const DUPLICATE_KEY_ERROR = 11000;

@Injectable()
export class PatientsRepository {
  private readonly patients: Collection<PatientDocument>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.patients = db.collection('patients');
  }

  /**
   * Atomically takes the patient if nobody holds a live lease. Upsert creates the document on
   * first sight; if another worker holds it, the filter misses, the upsert tries to insert the
   * same _id and fails with a duplicate key — which here just means "not yours".
   */
  async tryClaim(patientId: string, owner: string, expiresAt: Date): Promise<PatientDocument | null> {
    try {
      return await this.patients.findOneAndUpdate(
        { _id: patientId, $or: [{ lease: null }, { 'lease.expiresAt': { $lte: new Date() } }] },
        {
          $set: { lease: { owner, expiresAt } },
          $setOnInsert: { state: emptyPatientState(), version: 0 },
        },
        { upsert: true, returnDocument: 'after' },
      );
    } catch (error) {
      if (error instanceof MongoServerError && error.code === DUPLICATE_KEY_ERROR) return null;
      throw error;
    }
  }

  /** False means the lease was lost (expired and taken over). */
  async extendLease(patientId: string, owner: string, expiresAt: Date): Promise<boolean> {
    const { matchedCount } = await this.patients.updateOne(
      { _id: patientId, 'lease.owner': owner },
      { $set: { 'lease.expiresAt': expiresAt } },
    );
    return matchedCount === 1;
  }

  async release(patientId: string, owner: string): Promise<void> {
    await this.patients.updateOne({ _id: patientId, 'lease.owner': owner }, { $set: { lease: null } });
  }

  async get(patientId: string): Promise<PatientDocument | null> {
    return this.patients.findOne({ _id: patientId });
  }

  /**
   * Conditional on the version the fold was computed against. If a worker whose lease expired
   * is still writing, one of the two writers fails here instead of silently overwriting the other.
   */
  async saveState(patientId: string, expectedVersion: number, state: PatientState): Promise<boolean> {
    const { matchedCount } = await this.patients.updateOne(
      { _id: patientId, version: expectedVersion },
      { $set: { state }, $inc: { version: 1 } },
    );
    return matchedCount === 1;
  }
}
