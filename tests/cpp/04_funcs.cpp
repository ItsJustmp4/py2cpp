#include <iostream>
#include <vector>
#include <algorithm>
#include <cmath>
using namespace std;

int counter = 0;

void bump() {
    counter++;
}

long long fact(int n) {
    return n <= 1 ? 1 : n * fact(n - 1);
}

bool isPrime(int n) {
    if (n < 2) return false;
    for (int d = 2; d * d <= n; d++)
        if (n % d == 0)
            return false;
    return true;
}

string grade(int score) {
    switch (score / 10) {
        case 10:
        case 9: return "A";
        case 8: return "B";
        default: return "C";
    }
}

int main() {
    for (int i = 0; i < 3; i++) bump();
    cout << counter << endl;
    cout << fact(10) << endl;
    vector<int> primes;
    for (int i = 0; i < 30; i++)
        if (isPrime(i)) primes.push_back(i);
    cout << primes.size() << " " << primes.back() << endl;
    vector<int> w = {5, 2, 9};
    sort(w.begin(), w.end());
    cout << w[0] << w[1] << w[2] << endl;
    cout << grade(95) << grade(85) << grade(10) << endl;
    cout << pow(2, 10) << endl;
    int a = 1, b = 2;
    swap(a, b);
    cout << a << b << endl;
    string s = "hello world";
    cout << s.substr(0, 5) << "|" << s.length() << endl;
    int m[2][3] = {};
    m[1][2] = 7;
    cout << m[1][2] << m[0][0] << endl;
    return 0;
}
