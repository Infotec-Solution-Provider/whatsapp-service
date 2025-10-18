import axios from 'axios';

// Configurações da API - podem ser definidas em window.APP_CONFIG
const INSTANCES_API_URL = (window as any).APP_CONFIG?.INSTANCES_API_URL || 'http://localhost:8000';
const AUTH_TOKEN = (window as any).APP_CONFIG?.AUTH_TOKEN || '';

export interface Instance {
  id: number;
  name: string;
  clientName: string;
  createdAt: string;
  updatedAt: string;
}

export interface InstancesResponse {
  message: string;
  data: Instance[];
}

class InstancesApiService {
  private baseUrl = `${INSTANCES_API_URL}/api/instances`;

  async getAll(): Promise<Instance[]> {
    try {
      const response = await axios.get<InstancesResponse>(this.baseUrl, {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      return response.data.data;
    } catch (error) {
      console.error('Erro ao buscar instâncias:', error);
      // Retorna instâncias mockadas em caso de erro (fallback)
      return [
        { id: 1, name: 'Vollo', clientName: 'vollo', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 2, name: 'Karsten', clientName: 'karsten', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 3, name: 'Exatron', clientName: 'exatron', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 4, name: 'Develop', clientName: 'develop', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ];
    }
  }

  async getByName(clientName: string): Promise<Instance | null> {
    try {
      const response = await axios.get<{ message: string; data: Instance }>(`${this.baseUrl}/${clientName}`, {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      return response.data.data;
    } catch (error) {
      console.error(`Erro ao buscar instância ${clientName}:`, error);
      return null;
    }
  }
}

export const instancesApiService = new InstancesApiService();
